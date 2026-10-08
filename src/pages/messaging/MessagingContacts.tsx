/**
 * Messaging contacts: spreadsheet import, block/unblock, and DNC lookups.
 *
 * Import is deliberately server-side — the file is uploaded and parsed by the
 * backend, which reports back exactly how it mapped the sheet's headers so a
 * mis-mapped column is visible before the list is used for a broadcast.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Ban, CheckCircle2, Loader2, ShieldAlert, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import {
    blockContact,
    checkDnc,
    fetchContacts,
    fetchLeadBatches,
    importContacts,
    unblockContact,
    type ContactDisposition,
    type DncResult,
    type ImportSummary,
    type LeadBatch,
    type MessagingContact,
} from '@/services/messaging/messagingApi';

/**
 * The status filter is one control over two different facts.
 *
 * "Blocked / opted out" is what an operator actually wants to see — a manual
 * block and an inbound STOP mean the same thing to them — but they are stored
 * separately, one on the contact and one as a suppression row. The server
 * resolves both behind `suppressed`.
 */
type StatusFilter = 'ALL' | 'ACTIVE' | 'BLOCKED' | 'SUPPRESSED';

const DISPOSITION_LABELS: Record<ContactDisposition, string> = {
    NEW: 'New',
    INTERESTED: 'Interested',
    NOT_INTERESTED: 'Not interested',
};

export default function MessagingContacts() {
    const [contacts, setContacts] = useState<MessagingContact[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
    const [dispositionFilter, setDispositionFilter] = useState<'ALL' | ContactDisposition>('ALL');
    const [batchFilter, setBatchFilter] = useState<string>('ALL');
    const [batches, setBatches] = useState<LeadBatch[]>([]);

    const [file, setFile] = useState<File | null>(null);
    const [isImporting, setIsImporting] = useState(false);
    const [lastImport, setLastImport] = useState<ImportSummary | null>(null);

    const [dncNumber, setDncNumber] = useState('');
    const [dncResult, setDncResult] = useState<DncResult | null>(null);
    const [isCheckingDnc, setIsCheckingDnc] = useState(false);

    const load = useCallback(async () => {
        setIsLoading(true);
        try {
            const response = await fetchContacts({
                page: 1,
                pageSize: 100,
                search: search || undefined,
                status:
                    statusFilter === 'ACTIVE' || statusFilter === 'BLOCKED' ? statusFilter : undefined,
                suppressed: statusFilter === 'SUPPRESSED' || undefined,
                disposition: dispositionFilter === 'ALL' ? undefined : dispositionFilter,
                batchId: batchFilter === 'ALL' ? undefined : batchFilter,
            });
            setContacts(response.data);
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to load contacts');
        } finally {
            setIsLoading(false);
        }
    }, [batchFilter, dispositionFilter, search, statusFilter]);

    // Batches change only on an upload, so they load once rather than with
    // every filter change.
    useEffect(() => {
        fetchLeadBatches()
            .then(setBatches)
            .catch(() => setBatches([]));
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const handleImport = useCallback(async () => {
        if (!file) {
            toast.error('Choose a spreadsheet first');
            return;
        }

        setIsImporting(true);
        try {
            const summary = await importContacts(file);
            setLastImport(summary);
            setFile(null);
            toast.success(`Imported ${summary.imported} new, updated ${summary.updated}`);
            void load().catch(() => {
                toast.info('Import saved — refresh if the list looks stale.');
            });
        } catch (error: any) {
            const timedOut =
                error?.code === 'ECONNABORTED' ||
                String(error?.message ?? '').toLowerCase().includes('timeout');
            if (timedOut) {
                toast.warn(
                    'Upload took too long to confirm. Refresh — contacts may already be imported.',
                );
                void load();
            } else {
                toast.error(error?.response?.data?.message || error?.message || 'Import failed');
            }
        } finally {
            setIsImporting(false);
        }
    }, [file, load]);

    const handleToggleBlock = useCallback(
        async (contact: MessagingContact) => {
            try {
                if (contact.status === 'BLOCKED') {
                    await unblockContact(contact.phoneNumber);
                } else {
                    await blockContact(contact.phoneNumber);
                }
                await load();
            } catch (error: any) {
                toast.error(error?.response?.data?.message || 'Failed to update contact');
            }
        },
        [load],
    );

    const handleDncCheck = useCallback(async () => {
        const phoneNumber = dncNumber.trim();
        if (!phoneNumber) return;

        setIsCheckingDnc(true);
        try {
            setDncResult(await checkDnc(phoneNumber));
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'DNC lookup failed');
        } finally {
            setIsCheckingDnc(false);
        }
    }, [dncNumber]);

    return (
        <div className="space-y-6 p-4">
            <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <Upload className="h-4 w-4" /> Import leads
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="space-y-1">
                            <Label htmlFor="contact-file">Spreadsheet (.xlsx, .xls or .csv)</Label>
                            <Input
                                id="contact-file"
                                type="file"
                                accept=".xlsx,.xls,.csv"
                                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                            />
                            <p className="text-xs text-muted-foreground">
                                A phone column is required. Name, email, company, address and tag columns are
                                detected automatically.
                            </p>
                        </div>

                        <Button onClick={handleImport} disabled={isImporting || !file}>
                            {isImporting ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Upload className="mr-1 h-4 w-4" />}
                            Import
                        </Button>

                        {lastImport && (
                            <div className="rounded-md border p-3 text-xs">
                                <p className="font-medium">
                                    {lastImport.totalRows} rows · {lastImport.imported} new · {lastImport.updated} updated
                                    {lastImport.skippedInvalid > 0 && ` · ${lastImport.skippedInvalid} invalid`}
                                    {lastImport.skippedDuplicate > 0 && ` · ${lastImport.skippedDuplicate} duplicates`}
                                </p>

                                <p className="mt-2 text-muted-foreground">Column mapping</p>
                                <ul className="mt-1 space-y-0.5 text-muted-foreground">
                                    {Object.entries(lastImport.columnMapping).map(([header, field]) => (
                                        <li key={header}>
                                            <span className="font-mono">{header}</span> → {field}
                                        </li>
                                    ))}
                                </ul>

                                {lastImport.sampleErrors.length > 0 && (
                                    <>
                                        <p className="mt-2 text-red-500">Rejected rows</p>
                                        <ul className="mt-1 space-y-0.5 text-red-500">
                                            {lastImport.sampleErrors.map((entry) => (
                                                <li key={entry.row}>
                                                    Row {entry.row}: {entry.reason}
                                                </li>
                                            ))}
                                        </ul>
                                    </>
                                )}
                            </div>
                        )}
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2 text-base">
                            <ShieldAlert className="h-4 w-4" /> DNC check
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                        <div className="flex gap-2">
                            <Input
                                value={dncNumber}
                                onChange={(event) => setDncNumber(event.target.value)}
                                onKeyDown={(event) => event.key === 'Enter' && handleDncCheck()}
                                placeholder="Phone number"
                            />
                            <Button onClick={handleDncCheck} disabled={isCheckingDnc}>
                                {isCheckingDnc ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Check'}
                            </Button>
                        </div>

                        {dncResult && (
                            <div className="rounded-md border p-3 text-sm">
                                <p className="flex items-center gap-2">
                                    {dncResult.status === 'listed' ? (
                                        <Badge variant="destructive">On DNC list</Badge>
                                    ) : dncResult.status === 'clear' ? (
                                        <Badge variant="secondary" className="gap-1">
                                            <CheckCircle2 className="h-3 w-3" /> Clear
                                        </Badge>
                                    ) : (
                                        <Badge variant="outline">Unknown</Badge>
                                    )}
                                    <span className="font-mono text-xs">{dncResult.phoneNumber}</span>
                                </p>

                                <p className="mt-1 text-xs text-muted-foreground">
                                    {dncResult.carrier && `${dncResult.carrier} · `}
                                    {dncResult.numberType && `${dncResult.numberType} · `}
                                    {dncResult.cached ? 'cached result' : 'fresh lookup'}
                                </p>

                                {dncResult.status === 'listed' && (
                                    <p className="mt-2 text-xs text-red-500">
                                        A suppression has been recorded — this number can no longer be messaged.
                                    </p>
                                )}
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                    <CardTitle className="text-base">Contacts</CardTitle>
                    <div className="flex gap-2">
                        <Input
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Search"
                            className="h-9 w-48"
                        />
                        <select
                            value={dispositionFilter}
                            onChange={(event) =>
                                setDispositionFilter(event.target.value as typeof dispositionFilter)
                            }
                            className="h-9 rounded-md border bg-background px-2 text-sm"
                            title="Filter by how the lead was marked in the inbox"
                        >
                            <option value="ALL">Any marker</option>
                            <option value="NEW">New</option>
                            <option value="INTERESTED">Interested</option>
                            <option value="NOT_INTERESTED">Not interested</option>
                        </select>
                        {batches.length > 0 && (
                            <select
                                value={batchFilter}
                                onChange={(event) => setBatchFilter(event.target.value)}
                                className="h-9 max-w-44 rounded-md border bg-background px-2 text-sm"
                                title="Filter by the upload these leads came from"
                            >
                                <option value="ALL">Any batch</option>
                                {batches.map((batch) => (
                                    <option key={batch.id} value={batch.id}>
                                        {batch.name} ({batch.myLeadCount})
                                    </option>
                                ))}
                            </select>
                        )}
                        <select
                            value={statusFilter}
                            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                            className="h-9 rounded-md border bg-background px-2 text-sm"
                        >
                            <option value="ALL">All</option>
                            <option value="ACTIVE">Active</option>
                            <option value="BLOCKED">Blocked</option>
                            <option value="SUPPRESSED">Blocked / opted out</option>
                        </select>
                    </div>
                </CardHeader>

                <CardContent>
                    {isLoading ? (
                        <p className="text-sm text-muted-foreground">Loading…</p>
                    ) : contacts.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No contacts found.</p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Phone</TableHead>
                                    <TableHead>Company</TableHead>
                                    <TableHead>Marker</TableHead>
                                    <TableHead>Batch</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {contacts.map((contact) => (
                                    <TableRow key={contact.id}>
                                        <TableCell>
                                            {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || '—'}
                                        </TableCell>
                                        <TableCell className="font-mono text-xs">{contact.phoneNumber}</TableCell>
                                        <TableCell>{contact.company || '—'}</TableCell>
                                        <TableCell>
                                            {contact.disposition === 'INTERESTED' ? (
                                                <Badge className="bg-emerald-600 hover:bg-emerald-600">
                                                    {DISPOSITION_LABELS.INTERESTED}
                                                </Badge>
                                            ) : contact.disposition === 'NOT_INTERESTED' ? (
                                                <Badge variant="outline" className="border-amber-500 text-amber-600">
                                                    {DISPOSITION_LABELS.NOT_INTERESTED}
                                                </Badge>
                                            ) : (
                                                <span className="text-xs text-muted-foreground">
                                                    {DISPOSITION_LABELS.NEW}
                                                </span>
                                            )}
                                        </TableCell>
                                        <TableCell className="max-w-36 truncate text-xs text-muted-foreground">
                                            {contact.batch?.name || '—'}
                                        </TableCell>
                                        <TableCell>
                                            {contact.status === 'BLOCKED' ? (
                                                <Badge variant="destructive">Blocked</Badge>
                                            ) : (
                                                <Badge variant="secondary">Active</Badge>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-right">
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                onClick={() => handleToggleBlock(contact)}
                                            >
                                                <Ban className="mr-1 h-3.5 w-3.5" />
                                                {contact.status === 'BLOCKED' ? 'Unblock' : 'Block'}
                                            </Button>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
