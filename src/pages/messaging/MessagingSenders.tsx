/**
 * Admin screen for sending numbers.
 *
 * Two halves: the registry of numbers, and who sends from each. A user with no
 * assignment falls back to the server's INFOBIP_SENDER, so the whole feature
 * can be rolled out without interrupting anyone.
 *
 * Assigning a sender is not cosmetic — it also decides which conversations that
 * user can see, because the inbox is scoped to their own number. The screen
 * says so plainly rather than leaving it to be discovered.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Loader2, Phone, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
    assignSender,
    createSender,
    deleteSender,
    fetchSenderAssignments,
    fetchSenders,
    updateSender,
    type MessagingSender,
    type SenderAssignment,
} from '@/services/messaging/messagingApi';

function formatPhone(value: string): string {
    const digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
        return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
    }
    if (digits.length === 10) {
        return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    return value;
}

function userLabel(user: SenderAssignment): string {
    const name = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim();
    return name || user.email;
}

export default function MessagingSenders() {
    const [senders, setSenders] = useState<MessagingSender[]>([]);
    const [assignments, setAssignments] = useState<SenderAssignment[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [savingUserId, setSavingUserId] = useState<string | null>(null);

    const [isAddOpen, setIsAddOpen] = useState(false);
    const [newNumber, setNewNumber] = useState('');
    const [newLabel, setNewLabel] = useState('');
    const [isSaving, setIsSaving] = useState(false);
    const [pendingDelete, setPendingDelete] = useState<MessagingSender | null>(null);

    const load = useCallback(async () => {
        setIsLoading(true);
        try {
            const [senderRows, assignmentRows] = await Promise.all([
                fetchSenders(),
                fetchSenderAssignments(),
            ]);
            setSenders(senderRows);
            setAssignments(assignmentRows);
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to load senders');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const activeSenders = useMemo(() => senders.filter((s) => s.isActive), [senders]);

    const handleAdd = useCallback(async () => {
        if (!newNumber.trim()) return;
        setIsSaving(true);
        try {
            await createSender({ phoneNumber: newNumber.trim(), label: newLabel.trim() || null });
            setNewNumber('');
            setNewLabel('');
            setIsAddOpen(false);
            await load();
            toast.success('Sender added');
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Could not add that number');
        } finally {
            setIsSaving(false);
        }
    }, [load, newLabel, newNumber]);

    const handleToggleActive = useCallback(
        async (sender: MessagingSender) => {
            try {
                await updateSender(sender.id, {
                    phoneNumber: sender.phoneNumber,
                    label: sender.label,
                    isActive: !sender.isActive,
                });
                await load();
            } catch (error: any) {
                toast.error(error?.response?.data?.message || 'Could not update that sender');
            }
        },
        [load],
    );

    const handleDelete = useCallback(async () => {
        if (!pendingDelete) return;
        try {
            await deleteSender(pendingDelete.id);
            setPendingDelete(null);
            await load();
            toast.success('Sender removed');
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Could not remove that sender');
        }
    }, [load, pendingDelete]);

    const handleAssign = useCallback(
        async (userId: string, senderId: string) => {
            setSavingUserId(userId);
            try {
                await assignSender(userId, senderId || null);
                await load();
            } catch (error: any) {
                toast.error(error?.response?.data?.message || 'Could not assign that sender');
            } finally {
                setSavingUserId(null);
            }
        },
        [load],
    );

    return (
        <div className="space-y-6 p-4">
            {/* ─────────────── Registry ─────────────── */}
            <section className="rounded-xl border bg-background shadow-sm">
                <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
                    <div>
                        <h2 className="text-base font-semibold">Sending numbers</h2>
                        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                            Numbers messages and broadcasts go out from. A user with no number
                            assigned falls back to the server default.
                        </p>
                    </div>
                    <Button size="sm" onClick={() => setIsAddOpen(true)}>
                        <Plus className="mr-2 h-4 w-4" /> Add number
                    </Button>
                </header>

                <div className="p-4">
                    {isLoading && senders.length === 0 ? (
                        <div className="space-y-2">
                            {Array.from({ length: 3 }).map((_, index) => (
                                <div key={index} className="h-14 animate-pulse rounded-lg bg-muted" />
                            ))}
                        </div>
                    ) : senders.length === 0 ? (
                        <p className="py-6 text-center text-sm text-muted-foreground">
                            No numbers yet. Everyone is using the server default.
                        </p>
                    ) : (
                        <div className="space-y-2">
                            {senders.map((sender) => (
                                <div
                                    key={sender.id}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                                >
                                    <div className="flex min-w-0 items-center gap-3">
                                        <Phone className="h-4 w-4 shrink-0 text-muted-foreground" />
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">
                                                {formatPhone(sender.phoneNumber)}
                                            </p>
                                            <p className="truncate text-xs text-muted-foreground">
                                                {sender.label || 'No label'} ·{' '}
                                                {sender._count?.users ?? 0} user
                                                {(sender._count?.users ?? 0) === 1 ? '' : 's'}
                                            </p>
                                        </div>
                                    </div>

                                    <div className="flex shrink-0 items-center gap-2">
                                        <Badge variant={sender.isActive ? 'secondary' : 'destructive'}>
                                            {sender.isActive ? 'Active' : 'Inactive'}
                                        </Badge>
                                        <Button
                                            size="sm"
                                            variant="outline"
                                            onClick={() => void handleToggleActive(sender)}
                                        >
                                            {sender.isActive ? 'Deactivate' : 'Activate'}
                                        </Button>
                                        <Button
                                            size="icon"
                                            variant="ghost"
                                            className="h-8 w-8 text-muted-foreground hover:text-red-500"
                                            onClick={() => setPendingDelete(sender)}
                                            title="Remove this number"
                                        >
                                            <Trash2 className="h-4 w-4" />
                                        </Button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>

            {/* ─────────────── Assignment ─────────────── */}
            <section className="rounded-xl border bg-background shadow-sm">
                <header className="border-b p-4">
                    <h2 className="text-base font-semibold">Who sends from which number</h2>
                    <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                        A user&apos;s inbox shows only the conversations on their own number, so
                        changing this also changes what they can see. Admins and Super Admins
                        always see every conversation.
                    </p>
                </header>

                <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                        <thead className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
                            <tr>
                                <th className="px-4 py-2 text-left">User</th>
                                <th className="px-4 py-2 text-left">Role</th>
                                <th className="px-4 py-2 text-left">Sends from</th>
                            </tr>
                        </thead>
                        <tbody>
                            {assignments.map((user) => {
                                const privileged = ['ADMIN', 'SUPER_ADMIN'].includes(
                                    String(user.role || '').toUpperCase(),
                                );
                                return (
                                    <tr key={user.id} className="border-t">
                                        <td className="px-4 py-2">
                                            <p className="font-medium">{userLabel(user)}</p>
                                            <p className="text-xs text-muted-foreground">{user.email}</p>
                                        </td>
                                        <td className="px-4 py-2">
                                            <span className="text-xs text-muted-foreground">{user.role}</span>
                                            {privileged && (
                                                <p className="text-[11px] text-muted-foreground">
                                                    sees all conversations
                                                </p>
                                            )}
                                        </td>
                                        <td className="px-4 py-2">
                                            <div className="flex items-center gap-2">
                                                <select
                                                    value={user.messagingSender?.id ?? ''}
                                                    disabled={savingUserId === user.id}
                                                    onChange={(event) =>
                                                        void handleAssign(user.id, event.target.value)
                                                    }
                                                    className={cn(
                                                        'h-9 min-w-[14rem] rounded-md border bg-background px-2 text-sm',
                                                        savingUserId === user.id && 'opacity-60',
                                                    )}
                                                >
                                                    <option value="">Server default</option>
                                                    {activeSenders.map((sender) => (
                                                        <option key={sender.id} value={sender.id}>
                                                            {formatPhone(sender.phoneNumber)}
                                                            {sender.label ? ` — ${sender.label}` : ''}
                                                        </option>
                                                    ))}
                                                </select>
                                                {savingUserId === user.id && (
                                                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </section>

            <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Add a sending number</DialogTitle>
                        <DialogDescription>
                            The number must already be provisioned with Infobip. It is stored in
                            E.164 so inbound replies thread against it correctly.
                        </DialogDescription>
                    </DialogHeader>

                    <div className="space-y-3">
                        <div>
                            <label className="mb-1 block text-xs text-muted-foreground">Phone number</label>
                            <Input
                                value={newNumber}
                                onChange={(event) => setNewNumber(event.target.value)}
                                placeholder="+1 917 615 0642"
                            />
                        </div>
                        <div>
                            <label className="mb-1 block text-xs text-muted-foreground">
                                Label (optional)
                            </label>
                            <Input
                                value={newLabel}
                                onChange={(event) => setNewLabel(event.target.value)}
                                placeholder="Sales desk"
                            />
                        </div>
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="outline" onClick={() => setIsAddOpen(false)} disabled={isSaving}>
                            Cancel
                        </Button>
                        <Button onClick={handleAdd} disabled={isSaving || !newNumber.trim()}>
                            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Add
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>

            <Dialog
                open={Boolean(pendingDelete)}
                onOpenChange={(open: boolean) => !open && setPendingDelete(null)}
            >
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Remove this number?</DialogTitle>
                        <DialogDescription>
                            {pendingDelete
                                ? `${formatPhone(pendingDelete.phoneNumber)} will no longer be assignable.`
                                : ''}
                        </DialogDescription>
                    </DialogHeader>

                    <p className="text-xs text-muted-foreground">
                        Anyone currently assigned to it falls back to the server default, so nobody
                        loses the ability to send. Existing conversations are not deleted, but they
                        will only be visible to admins once no user is on this number.
                    </p>

                    <div className="flex justify-end gap-2 pt-2">
                        <Button variant="outline" onClick={() => setPendingDelete(null)}>
                            Cancel
                        </Button>
                        <Button variant="destructive" onClick={handleDelete}>
                            Remove
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    );
}
