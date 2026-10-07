/**
 * Admin screen: upload a lead sheet and share it out across users.
 *
 * Leads are `MessagingContact` rows and ownership is `ownerUserId`, the same
 * field the rest of the messaging module already uses — so a distributed lead
 * simply appears in that user's Contacts & DNC, with no parallel concept to
 * keep in sync.
 *
 * Rows are dealt round-robin rather than sliced into blocks. An even split
 * survives a row count that does not divide evenly, and any ordering in the
 * source file (sorted by state, say) spreads across everyone instead of giving
 * one rep every lead from one region.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { Loader2, Upload, Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import {
    fetchLeadDistribution,
    fetchSenderAssignments,
    importContacts,
    type ImportSummary,
    type LeadDistributionRow,
    type SenderAssignment,
} from '@/services/messaging/messagingApi';

function userLabel(user: { firstName: string | null; lastName: string | null; email: string }): string {
    const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    return name || user.email;
}

export default function LeadDistribution() {
    // `fetchSenderAssignments` already returns every active user with their
    // name, email and role — exactly the picker this screen needs, so it is
    // reused rather than adding a second near-identical endpoint.
    const [users, setUsers] = useState<SenderAssignment[]>([]);
    const [distribution, setDistribution] = useState<LeadDistributionRow[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const [selected, setSelected] = useState<string[]>([]);
    const [file, setFile] = useState<File | null>(null);
    const [isUploading, setIsUploading] = useState(false);
    const [summary, setSummary] = useState<ImportSummary | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const load = useCallback(async () => {
        setIsLoading(true);
        try {
            const [userRows, distributionRows] = await Promise.all([
                fetchSenderAssignments(),
                fetchLeadDistribution(),
            ]);
            setUsers(userRows);
            setDistribution(distributionRows);
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to load lead distribution');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const countByUser = useMemo(() => {
        const map = new Map<string, number>();
        for (const row of distribution) {
            if (row.userId) map.set(row.userId, row.count);
        }
        return map;
    }, [distribution]);

    const unassignedCount = useMemo(
        () => distribution.find((row) => !row.userId)?.count ?? 0,
        [distribution],
    );

    const toggleUser = useCallback((userId: string) => {
        setSelected((prev) =>
            prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
        );
    }, []);

    const handleUpload = useCallback(async () => {
        if (!file) return;
        if (selected.length === 0) {
            toast.error('Pick at least one user to share the leads with');
            return;
        }

        setIsUploading(true);
        setSummary(null);
        try {
            const result = await importContacts(file, undefined, selected);
            setSummary(result);
            setFile(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
            await load();
            toast.success(`${result.imported + result.updated} leads distributed`);
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Import failed');
        } finally {
            setIsUploading(false);
        }
    }, [file, load, selected]);

    const nameForUserId = useCallback(
        (userId: string) => {
            const match = users.find((u) => u.id === userId);
            return match ? userLabel(match) : userId;
        },
        [users],
    );

    return (
        <div className="space-y-6 p-4">
            {/* ─────────────── Upload ─────────────── */}
            <section className="rounded-xl border bg-background shadow-sm">
                <header className="border-b p-4">
                    <h2 className="text-base font-semibold">Upload leads</h2>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                        Upload a spreadsheet (.xlsx, .xls or .csv) and choose who to share it
                        with. Rows are dealt out one at a time so everyone gets a roughly equal
                        share. Each user then sees their own leads in Contacts &amp; DNC.
                    </p>
                </header>

                <div className="space-y-4 p-4">
                    <div>
                        <label className="mb-1 block text-xs text-muted-foreground">
                            Spreadsheet
                        </label>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".xlsx,.xls,.csv"
                            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                            className="block w-full max-w-md cursor-pointer rounded-md border bg-background p-2 text-sm"
                        />
                        <p className="mt-1 text-xs text-muted-foreground">
                            A phone number column is required. Other recognized columns (name,
                            company, email, city, state) are imported when present.
                        </p>
                    </div>

                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <label className="text-xs text-muted-foreground">
                                Share across ({selected.length} selected)
                            </label>
                            <div className="flex gap-2">
                                <button
                                    type="button"
                                    className="text-xs text-primary underline-offset-2 hover:underline"
                                    onClick={() => setSelected(users.map((u) => u.id))}
                                >
                                    Select all
                                </button>
                                <button
                                    type="button"
                                    className="text-xs text-muted-foreground underline-offset-2 hover:underline"
                                    onClick={() => setSelected([])}
                                >
                                    Clear
                                </button>
                            </div>
                        </div>

                        <div className="flex flex-wrap gap-2">
                            {users.map((user) => {
                                const isSelected = selected.includes(user.id);
                                return (
                                    <button
                                        key={user.id}
                                        type="button"
                                        onClick={() => toggleUser(user.id)}
                                        className={cn(
                                            'rounded-full border px-3 py-1.5 text-xs transition-colors',
                                            isSelected
                                                ? 'border-primary bg-primary text-primary-foreground'
                                                : 'bg-background hover:bg-muted',
                                        )}
                                    >
                                        {userLabel(user)}
                                        <span className="ml-1.5 opacity-70">
                                            {countByUser.get(user.id) ?? 0}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                        {selected.length > 0 && file && (
                            <p className="mt-2 text-xs text-muted-foreground">
                                Leads will be split across {selected.length} user
                                {selected.length === 1 ? '' : 's'}.
                            </p>
                        )}
                    </div>

                    <Button onClick={handleUpload} disabled={!file || isUploading}>
                        {isUploading ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                            <Upload className="mr-2 h-4 w-4" />
                        )}
                        Upload and distribute
                    </Button>

                    {summary && (
                        <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                            <p className="font-medium">Import complete</p>
                            <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                                <li>{summary.totalRows} rows read</li>
                                <li>
                                    {summary.imported} new · {summary.updated} updated
                                </li>
                                {summary.skippedInvalid > 0 && (
                                    <li className="text-amber-600">
                                        {summary.skippedInvalid} skipped as invalid
                                    </li>
                                )}
                                {summary.skippedDuplicate > 0 && (
                                    <li>{summary.skippedDuplicate} duplicate rows in the file</li>
                                )}
                            </ul>

                            {summary.assigned && summary.assigned.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {summary.assigned.map((row) => (
                                        <Badge key={row.userId} variant="secondary">
                                            {nameForUserId(row.userId)}: {row.count}
                                        </Badge>
                                    ))}
                                </div>
                            )}

                            {summary.sampleErrors.length > 0 && (
                                <details className="mt-2">
                                    <summary className="cursor-pointer text-xs text-muted-foreground">
                                        Why rows were skipped
                                    </summary>
                                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                                        {summary.sampleErrors.map((err) => (
                                            <li key={`${err.row}-${err.reason}`}>
                                                Row {err.row}: {err.reason}
                                            </li>
                                        ))}
                                    </ul>
                                </details>
                            )}
                        </div>
                    )}
                </div>
            </section>

            {/* ─────────────── Current split ─────────────── */}
            <section className="rounded-xl border bg-background shadow-sm">
                <header className="flex items-center justify-between gap-3 border-b p-4">
                    <div>
                        <h2 className="text-base font-semibold">Leads per user</h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Who currently owns what. Users only see their own leads.
                        </p>
                    </div>
                    {unassignedCount > 0 && (
                        <Badge variant="destructive" className="shrink-0">
                            {unassignedCount} unassigned
                        </Badge>
                    )}
                </header>

                <div className="p-4">
                    {isLoading && distribution.length === 0 ? (
                        <div className="space-y-2">
                            {Array.from({ length: 4 }).map((_, index) => (
                                <div key={index} className="h-12 animate-pulse rounded-lg bg-muted" />
                            ))}
                        </div>
                    ) : distribution.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            No leads yet. Upload a sheet above.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {distribution.map((row) => (
                                <div
                                    key={row.userId ?? 'unassigned'}
                                    className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                                >
                                    <div className="flex min-w-0 items-center gap-3">
                                        <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">
                                                {row.user ? userLabel(row.user) : 'Unassigned'}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {row.user?.email ?? 'Visible to admins only'}
                                            </p>
                                        </div>
                                    </div>
                                    <span className="shrink-0 text-sm font-semibold">
                                        {row.count.toLocaleString()}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
