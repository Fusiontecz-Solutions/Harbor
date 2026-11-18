/**
 * Pick CRM clients as messaging recipients.
 *
 * Harbor already knows every merchant, so the audience for a text or a blast
 * should come from `Client` rather than a re-exported spreadsheet. Two things
 * this surfaces that a raw list cannot:
 *
 *   - **Suppressed clients are shown but not selectable.** An operator needs to
 *     see that a merchant was excluded and why, otherwise "why didn't Bob get
 *     it?" becomes a support ticket.
 *   - **Landline warning.** We prefer the owner's mobile; when only a business
 *     number exists it is flagged, because business lines silently fail at the
 *     carrier rather than bouncing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Ban, Loader2, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { fetchClientRecipients, type ClientRecipient } from '@/services/messaging/messagingApi';

interface ClientPickerProps {
    selectedIds: string[];
    onChange: (ids: string[]) => void;
    /** Single-select collapses the checkboxes into a click-to-choose list. */
    mode?: 'multi' | 'single';
    /** Called in single mode with the chosen client. */
    onPick?: (client: ClientRecipient) => void;
    className?: string;
}

function useDebounced<T>(value: T, delayMs = 300): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setDebounced(value), delayMs);
        return () => clearTimeout(timer);
    }, [delayMs, value]);
    return debounced;
}

export function ClientPicker({ selectedIds, onChange, mode = 'multi', onPick, className }: ClientPickerProps) {
    const [searchInput, setSearchInput] = useState('');
    const search = useDebounced(searchInput);

    const [clients, setClients] = useState<ClientRecipient[]>([]);
    const [total, setTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setIsLoading(true);

        fetchClientRecipients({ search, page: 1, pageSize: 100 })
            .then((response) => {
                if (cancelled) return;
                setClients(response.data);
                setTotal(response.pagination.total ?? response.data.length);
                setError(null);
            })
            .catch((err: any) => {
                if (cancelled) return;
                setError(err?.response?.data?.message || 'Failed to load clients');
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [search]);

    const selectable = useMemo(() => clients.filter((c) => c.phoneNumber && !c.suppressed), [clients]);
    const allSelected = selectable.length > 0 && selectable.every((c) => selectedIds.includes(c.clientId));

    const toggle = useCallback(
        (client: ClientRecipient) => {
            if (!client.phoneNumber || client.suppressed) return;

            if (mode === 'single') {
                onPick?.(client);
                return;
            }

            onChange(
                selectedIds.includes(client.clientId)
                    ? selectedIds.filter((id) => id !== client.clientId)
                    : [...selectedIds, client.clientId],
            );
        },
        [mode, onChange, onPick, selectedIds],
    );

    const toggleAll = useCallback(() => {
        const ids = selectable.map((c) => c.clientId);
        onChange(allSelected ? selectedIds.filter((id) => !ids.includes(id)) : [...new Set([...selectedIds, ...ids])]);
    }, [allSelected, onChange, selectable, selectedIds]);

    return (
        <div className={cn('flex flex-col gap-2', className)}>
            <div className="flex items-center gap-2">
                <div className="relative flex-1">
                    <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={searchInput}
                        onChange={(event) => setSearchInput(event.target.value)}
                        placeholder="Search business, owner, email or phone"
                        className="pl-8"
                    />
                </div>
                {mode === 'multi' && (
                    <Button type="button" size="sm" variant="secondary" onClick={toggleAll} disabled={selectable.length === 0}>
                        {allSelected ? 'Clear' : `Select ${selectable.length}`}
                    </Button>
                )}
            </div>

            {mode === 'multi' && (
                <p className="text-xs text-muted-foreground">
                    {selectedIds.length} selected · {total} client{total === 1 ? '' : 's'} with a phone number
                </p>
            )}

            <div className="max-h-72 overflow-y-auto rounded-md border">
                {error ? (
                    <p className="p-3 text-sm text-red-500">{error}</p>
                ) : isLoading ? (
                    <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> Loading clients…
                    </p>
                ) : clients.length === 0 ? (
                    <p className="p-3 text-sm text-muted-foreground">
                        No clients with a usable phone number{search ? ' match that search' : ''}.
                    </p>
                ) : (
                    clients.map((client) => {
                        const disabled = !client.phoneNumber || client.suppressed;
                        const checked = selectedIds.includes(client.clientId);

                        return (
                            <button
                                key={client.clientId}
                                type="button"
                                onClick={() => toggle(client)}
                                disabled={disabled}
                                className={cn(
                                    'flex w-full items-center gap-3 border-b px-3 py-2 text-left last:border-b-0',
                                    disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted/60',
                                    checked && 'bg-muted',
                                )}
                            >
                                {mode === 'multi' && (
                                    <Checkbox checked={checked} disabled={disabled} className="pointer-events-none" />
                                )}

                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <span className="truncate text-sm font-medium">{client.businessName}</span>
                                        <span className="shrink-0 text-[11px] text-muted-foreground">
                                            #{client.clientNumber}
                                        </span>
                                    </div>
                                    <p className="truncate text-xs text-muted-foreground">
                                        {client.ownerName}
                                        {client.phoneNumber ? ` · ${client.phoneNumber}` : ' · no phone'}
                                        {client.city ? ` · ${client.city}, ${client.state ?? ''}` : ''}
                                    </p>
                                </div>

                                <div className="flex shrink-0 items-center gap-1">
                                    {client.phoneSource === 'business' && (
                                        <Badge
                                            variant="outline"
                                            className="gap-1"
                                            title="Only a business number is on file — it may be a landline that cannot receive SMS"
                                        >
                                            <AlertTriangle className="h-3 w-3" /> Landline?
                                        </Badge>
                                    )}
                                    {client.suppressed && (
                                        <Badge variant="destructive" className="gap-1" title={client.suppressionReason ?? ''}>
                                            <Ban className="h-3 w-3" />
                                            {client.suppressionReason === 'STOP_KEYWORD' ? 'Opted out' : 'Blocked'}
                                        </Badge>
                                    )}
                                </div>
                            </button>
                        );
                    })
                )}
            </div>
        </div>
    );
}

export default ClientPicker;
