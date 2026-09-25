/**
 * Chase a campaign's non-responders.
 *
 * The modal leads with the audience rather than the message box, because the
 * number that matters is how many people are actually left: a follow-up to a
 * campaign everybody answered is a mistake, and the operator should see that
 * before writing anything.
 *
 * Two rules are enforced by the server and surfaced here so they are not a
 * surprise at submit time — a follow-up may not go out sooner than an hour
 * after the original, and anyone marked Interested or Not Interested is out of
 * the audience.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import { Clock, Loader2, Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
    createFollowUp,
    fetchFollowUpPreview,
    fetchUpcomingSendWindows,
    type FollowUpPreview,
    type UpcomingSendWindow,
} from '@/services/messaging/messagingApi';

interface Props {
    broadcastId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}

/** `datetime-local` wants a local "YYYY-MM-DDTHH:mm" with no zone suffix. */
function toLocalInputValue(iso: string): string {
    const date = new Date(iso);
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

export default function FollowUpModal({ broadcastId, open, onOpenChange, onCreated }: Props) {
    const [preview, setPreview] = useState<FollowUpPreview | null>(null);
    const [windows, setWindows] = useState<UpcomingSendWindow[]>([]);
    const [isLoading, setIsLoading] = useState(true);

    const [name, setName] = useState('');
    const [body, setBody] = useState('');
    const [sendWindowId, setSendWindowId] = useState('');
    const [scheduledAt, setScheduledAt] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);

    useEffect(() => {
        if (!open) return;

        setIsLoading(true);
        Promise.all([fetchFollowUpPreview(broadcastId), fetchUpcomingSendWindows()])
            .then(([previewResult, windowResult]) => {
                setPreview(previewResult);
                // Only windows that clear the one-hour minimum are offered —
                // the rest would be rejected on submit.
                setWindows(
                    windowResult.filter(
                        (window) =>
                            new Date(window.nextOccurrence).getTime() >=
                            new Date(previewResult.earliestSendAt).getTime(),
                    ),
                );
                setScheduledAt(toLocalInputValue(previewResult.earliestSendAt));
            })
            .catch((error: any) =>
                toast.error(error?.response?.data?.message || 'Failed to load the follow-up audience'),
            )
            .finally(() => setIsLoading(false));
    }, [broadcastId, open]);

    const earliestLabel = useMemo(
        () => (preview ? new Date(preview.earliestSendAt).toLocaleString() : null),
        [preview],
    );

    const canSubmit =
        body.trim().length > 0 &&
        (Boolean(sendWindowId) || Boolean(scheduledAt)) &&
        (preview?.eligibleCount ?? 0) > 0 &&
        !isSubmitting;

    const submit = useCallback(async () => {
        setIsSubmitting(true);
        try {
            const result = await createFollowUp(broadcastId, {
                body: body.trim(),
                name: name.trim() || undefined,
                ...(sendWindowId
                    ? { sendWindowId }
                    : { scheduledAt: new Date(scheduledAt).toISOString() }),
            });

            toast.success(
                `Follow-up created for ${result.queuedCount.toLocaleString()} non-responders` +
                    (result.awaitingApproval ? ' — waiting for approval' : ''),
            );
            onOpenChange(false);
            onCreated();
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to create the follow-up');
        } finally {
            setIsSubmitting(false);
        }
    }, [body, broadcastId, name, onCreated, onOpenChange, scheduledAt, sendWindowId]);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Follow up</DialogTitle>
                    <DialogDescription>
                        Sends a second message to everyone who was reached by this campaign and
                        never replied.
                    </DialogDescription>
                </DialogHeader>

                {isLoading ? (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                        Working out who is left…
                    </p>
                ) : !preview ? null : (
                    <div className="space-y-4">
                        <div className="rounded-lg border bg-muted/30 p-3">
                            <p className="text-2xl leading-none font-semibold">
                                {preview.eligibleCount.toLocaleString()}
                            </p>
                            <p className="mt-1 text-xs text-muted-foreground">
                                never replied and are still unmarked
                            </p>
                            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
                                <li>{preview.excluded.replied.toLocaleString()} already replied</li>
                                <li>
                                    {preview.excluded.disposed.toLocaleString()} marked Interested /
                                    Not Interested, or blocked
                                </li>
                                <li>
                                    {preview.excluded.notDelivered.toLocaleString()} were never
                                    reached by the original
                                </li>
                            </ul>
                        </div>

                        {preview.eligibleCount === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Nobody is left to chase. Every recipient either answered, was
                                marked, or was never reached.
                            </p>
                        ) : (
                            <>
                                <div className="space-y-1.5">
                                    <Label htmlFor="fu-name">Campaign name</Label>
                                    <Input
                                        id="fu-name"
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                        placeholder={`${preview.parentName} — follow-up`}
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <Label htmlFor="fu-body">Message</Label>
                                    <Textarea
                                        id="fu-body"
                                        rows={4}
                                        value={body}
                                        onChange={(event) => setBody(event.target.value)}
                                        placeholder="Just following up on my last message…"
                                    />
                                </div>

                                <div className="space-y-1.5">
                                    <Label>When</Label>
                                    {windows.length > 0 && (
                                        <select
                                            value={sendWindowId}
                                            onChange={(event) => setSendWindowId(event.target.value)}
                                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                        >
                                            <option value="">A specific time…</option>
                                            {windows.map((window) => (
                                                <option key={window.id} value={window.id}>
                                                    {window.label ? `${window.label} — ` : ''}
                                                    {window.timeOfDay} ·{' '}
                                                    {new Date(window.nextOccurrence).toLocaleString(undefined, {
                                                        weekday: 'short',
                                                        hour: 'numeric',
                                                        minute: '2-digit',
                                                    })}
                                                </option>
                                            ))}
                                        </select>
                                    )}
                                    {!sendWindowId && (
                                        <Input
                                            type="datetime-local"
                                            value={scheduledAt}
                                            min={toLocalInputValue(preview.earliestSendAt)}
                                            onChange={(event) => setScheduledAt(event.target.value)}
                                        />
                                    )}
                                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                                        <Clock className="h-3 w-3" />
                                        The earliest a follow-up may go out is {earliestLabel} — an
                                        hour after the original.
                                    </p>
                                </div>
                            </>
                        )}
                    </div>
                )}

                <DialogFooter>
                    <Button variant="ghost" onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button onClick={submit} disabled={!canSubmit}>
                        {isSubmitting ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                            <Send className="mr-1 h-4 w-4" />
                        )}
                        Schedule follow-up
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
