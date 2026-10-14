/**
 * Broadcast creation wizard — modal, three steps, modelled on Fivra's
 * `add-broadcast-modal`.
 *
 *   1. Message   — name, body with merge tokens, live phone preview
 *   2. Audience  — CRM clients, saved contacts, or a spreadsheet upload
 *   3. Review    — throttle, schedule, and explicit acknowledgements
 *
 * Splitting it this way is not decoration: a blast is irreversible once it
 * starts, so the final step exists to make the operator confirm the audience
 * size and compliance before anything sends.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-toastify';
import {
    AlertTriangle,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    BatteryFull,
    CheckCircle2,
    Layers,
    Loader2,
    Send,
    Signal,
    Upload,
    Users,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { isAgentRole } from '@/lib/agentAccess';
import { resolveEffectiveRole } from '@/lib/sessionRole';
import { ClientPicker } from '@/components/messaging/ClientPicker';
import {
    confirmMultiSegmentSend,
    SmsComposeMeter,
    useSmsSegmentInfo,
} from '@/components/messaging/SmsComposeMeter';
import { AudienceBreakdown } from '@/components/messaging/AudienceBreakdown';
import {
    createBroadcastFromFile,
    createBroadcastFromList,
    fetchLeadBatches,
    previewBroadcastAudience,
    type AudiencePreview,
    fetchUpcomingSendWindows,
    type LeadBatch,
    type UpcomingSendWindow,
    type CreateBroadcastResult,
} from '@/services/messaging/messagingApi';

type AudienceSource = 'clients' | 'batch' | 'file' | 'manual';

interface CreateBroadcastModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated: () => void;
}

const TOTAL_STEPS = 3;

export function CreateBroadcastModal({ open, onOpenChange, onCreated }: CreateBroadcastModalProps) {
    // The CRM client book is admin-only; agents broadcast to the leads distributed to them.
    const canUseClients = !isAgentRole(resolveEffectiveRole(undefined));
    const defaultSource: AudienceSource = canUseClients ? 'clients' : 'batch';

    const [step, setStep] = useState(1);
    const [isSubmitting, setIsSubmitting] = useState(false);

    // Step 1
    const [name, setName] = useState('');
    const [body, setBody] = useState('');

    // Step 2
    const [source, setSource] = useState<AudienceSource>(defaultSource);
    const [clientIds, setClientIds] = useState<string[]>([]);
    const [leadBatchId, setLeadBatchId] = useState<string>('');
    const [batches, setBatches] = useState<LeadBatch[]>([]);
    const [sendWindows, setSendWindows] = useState<UpcomingSendWindow[]>([]);
    const [sendWindowId, setSendWindowId] = useState<string>('');
    const [file, setFile] = useState<File | null>(null);
    const [manualNumbers, setManualNumbers] = useState('');

    // Step 3
    const [throttle, setThrottle] = useState('10');
    const [scheduledAt, setScheduledAt] = useState('');
    const [ackCompliance, setAckCompliance] = useState(false);
    const [ackIrreversible, setAckIrreversible] = useState(false);

    const reset = useCallback(() => {
        setStep(1);
        setName('');
        setBody('');
        setSource(defaultSource);
        setClientIds([]);
        setLeadBatchId('');
        setFile(null);
        setManualNumbers('');
        setPreview(null);
        setPreviewError(null);
        setThrottle('10');
        setScheduledAt('');
        setAckCompliance(false);
        setAckIrreversible(false);
    }, [defaultSource]);

    const close = useCallback(
        (nextOpen: boolean) => {
            if (!nextOpen) reset();
            onOpenChange(nextOpen);
        },
        [onOpenChange, reset],
    );

    const manualList = useMemo(
        () =>
            manualNumbers
                .split(/[\n,;]+/)
                .map((value) => value.trim())
                .filter(Boolean),
        [manualNumbers],
    );

    /**
     * Batches and send windows are small, stable lists — loaded once when the
     * modal opens rather than on every step change.
     */
    useEffect(() => {
        if (!open) return;
        void fetchLeadBatches().then(setBatches).catch(() => setBatches([]));
        void fetchUpcomingSendWindows().then(setSendWindows).catch(() => setSendWindows([]));
    }, [open]);

    const selectedBatch = useMemo(
        () => batches.find((batch) => batch.id === leadBatchId) ?? null,
        [batches, leadBatchId],
    );

    /**
     * Server-side breakdown of the selected audience (opt-outs, blocks, already
     * marked leads, invalid and duplicate numbers). Refreshed shortly after the
     * selection changes; its `willSend` is the number that actually sends.
     */
    const [preview, setPreview] = useState<AudiencePreview | null>(null);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [previewError, setPreviewError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || step < 2) return;
        const input =
            source === 'batch' && leadBatchId
                ? { leadBatchId }
                : source === 'clients' && clientIds.length
                  ? { clientIds }
                  : source === 'manual' && manualList.length
                    ? { recipients: manualList.map((phoneNumber) => ({ phoneNumber })) }
                    : source === 'file' && file
                      ? { file }
                      : null;
        if (!input) {
            setPreview(null);
            setPreviewError(null);
            return;
        }
        let cancelled = false;
        setPreviewLoading(true);
        const timer = setTimeout(() => {
            previewBroadcastAudience(input)
                .then((data) => {
                    if (cancelled) return;
                    setPreview(data);
                    setPreviewError(null);
                })
                .catch((err: any) => {
                    if (cancelled) return;
                    setPreview(null);
                    setPreviewError(err?.response?.data?.message || 'Could not check this audience');
                })
                .finally(() => {
                    if (!cancelled) setPreviewLoading(false);
                });
        }, 400);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [open, step, source, leadBatchId, clientIds, manualList, file]);

    const audienceCount = useMemo(() => {
        if (preview) return preview.willSend;
        if (source === 'clients') return clientIds.length;
        if (source === 'manual') return manualList.length;
        // The batch count is the caller's own share, before blocked and
        // already-marked leads are dropped — so it is an upper bound.
        if (source === 'batch') return selectedBatch?.myLeadCount ?? 0;
        return file ? null : 0; // file size is only known server-side after parsing
    }, [clientIds.length, file, manualList.length, preview, selectedBatch, source]);

    const smsInfo = useSmsSegmentInfo(body);

    const mergeTokens = useMemo(() => {
        const matches = body.match(/\{\{\s*([\w.]+)\s*\}\}/g) ?? [];
        return [...new Set(matches.map((token) => token.replace(/[{}\s]/g, '')))];
    }, [body]);

    const canLeaveStepOne = name.trim().length > 0 && body.trim().length > 0;
    const canLeaveStepTwo =
        !(preview && preview.willSend === 0) &&
        ((source === 'clients' && clientIds.length > 0) ||
        (source === 'batch' && Boolean(leadBatchId)) ||
        (source === 'file' && Boolean(file)) ||
        (source === 'manual' && manualList.length > 0));
    const canSubmit = ackCompliance && ackIrreversible && !isSubmitting;

    const submit = useCallback(
        async (startNow: boolean) => {
            if (!confirmMultiSegmentSend(smsInfo, audienceCount)) return;

            setIsSubmitting(true);
            try {
                let result: CreateBroadcastResult;

                if (source === 'file' && file) {
                    result = await createBroadcastFromFile({
                        name: name.trim(),
                        body: body.trim(),
                        file,
                        throttlePerSecond: Number(throttle) || undefined,
                        startNow,
                    });
                } else {
                    result = await createBroadcastFromList({
                        name: name.trim(),
                        body: body.trim(),
                        ...(source === 'clients' ? { clientIds } : {}),
                        ...(source === 'batch' ? { leadBatchId } : {}),
                        ...(source === 'manual'
                            ? { recipients: manualList.map((phoneNumber) => ({ phoneNumber })) }
                            : {}),
                        throttlePerSecond: Number(throttle) || undefined,
                        // A window wins over a hand-picked time: picking one is
                        // the more deliberate choice of the two.
                        ...(sendWindowId ? { sendWindowId } : {}),
                        scheduledAt: scheduledAt ? new Date(scheduledAt).toISOString() : null,
                        startNow,
                    });
                }

                toast.success(
                    `${result.queuedCount.toLocaleString()} will receive this · ` +
                        `${result.suppressedCount} suppressed · ${result.duplicatesDropped} duplicates · ` +
                        `${result.invalidDropped} invalid`,
                );

                if (result.missingOwnerName) {
                    toast.info(`${result.missingOwnerName} lead(s) without an owner name were left out`);
                }

                if (result.skippedClients?.length) {
                    toast.warn(`${result.skippedClients.length} client(s) skipped — see the campaign for details`);
                }

                if (result.batchExcluded) {
                    const { blocked, disposed } = result.batchExcluded;
                    if (blocked + disposed > 0) {
                        toast.info(
                            `${disposed} already marked and ${blocked} blocked were left out of this batch`,
                        );
                    }
                }

                // An agent's campaign does not send on submit — say so plainly
                // rather than letting them assume it went out.
                if (result.awaitingApproval) {
                    toast.info('Sent for approval — an admin has to release it before it goes out');
                }

                close(false);
                onCreated();
            } catch (err: any) {
                toast.error(err?.response?.data?.message || 'Failed to create broadcast');
            } finally {
                setIsSubmitting(false);
            }
        },
        [
            body,
            clientIds,
            close,
            file,
            leadBatchId,
            manualList,
            name,
            onCreated,
            scheduledAt,
            sendWindowId,
            source,
            throttle,
            smsInfo,
            audienceCount,
        ],
    );

    return (
        <Dialog open={open} onOpenChange={close}>
            <DialogContent className="max-w-3xl">
                <DialogHeader>
                    <DialogTitle>New broadcast</DialogTitle>
                    <DialogDescription>
                        Step {step} of {TOTAL_STEPS} —{' '}
                        {step === 1 ? 'compose the message' : step === 2 ? 'choose the audience' : 'review and send'}
                    </DialogDescription>
                </DialogHeader>

                <StepIndicator current={step} total={TOTAL_STEPS} />

                <div className="max-h-[60vh] overflow-y-auto px-1 py-2">
                    {step === 1 && (
                        <div className="grid gap-5 md:grid-cols-2">
                            <div className="space-y-4">
                                <div className="space-y-1">
                                    <Label htmlFor="bc-name">Campaign name</Label>
                                    <Input
                                        id="bc-name"
                                        value={name}
                                        onChange={(event) => setName(event.target.value)}
                                        placeholder="March refi outreach"
                                    />
                                </div>

                                <div className="space-y-1">
                                    <Label htmlFor="bc-body">Message</Label>
                                    <Textarea
                                        id="bc-body"
                                        value={body}
                                        onChange={(event) => setBody(event.target.value)}
                                        rows={7}
                                        placeholder="Hi {{firstName}}, we have new terms available for {{company}}…"
                                    />
                                    <SmsComposeMeter
                                        text={body}
                                        recipientCount={step >= 2 ? audienceCount : null}
                                        onTextChange={setBody}
                                        showCampaignCreditHint
                                    />
                                </div>

                                {mergeTokens.length > 0 && (
                                    <div className="text-xs">
                                        <p className="mb-1 text-muted-foreground">Merge fields detected</p>
                                        <div className="flex flex-wrap gap-1">
                                            {mergeTokens.map((token) => (
                                                <Badge key={token} variant="secondary">
                                                    {token}
                                                </Badge>
                                            ))}
                                        </div>
                                        <p className="mt-1 text-muted-foreground">
                                            Resolved per recipient. Unknown fields render as empty text.
                                        </p>
                                    </div>
                                )}
                            </div>

                            <PhonePreview body={body} />
                        </div>
                    )}

                    {step === 2 && (
                        <Tabs value={source} onValueChange={(value: string) => setSource(value as AudienceSource)}>
                            <TabsList className={cn('grid w-full', canUseClients ? 'grid-cols-4' : 'grid-cols-3')}>
                                {canUseClients && (
                                    <TabsTrigger value="clients">
                                        <Users className="mr-1 h-4 w-4" /> CRM clients
                                    </TabsTrigger>
                                )}
                                <TabsTrigger value="batch">
                                    <Layers className="mr-1 h-4 w-4" /> Leads
                                </TabsTrigger>
                                <TabsTrigger value="file">
                                    <Upload className="mr-1 h-4 w-4" /> Spreadsheet
                                </TabsTrigger>
                                <TabsTrigger value="manual">Numbers</TabsTrigger>
                            </TabsList>

                            {canUseClients && (
                                <TabsContent value="clients" className="pt-3">
                                    <ClientPicker selectedIds={clientIds} onChange={setClientIds} />
                                </TabsContent>
                            )}

                            <TabsContent value="batch" className="space-y-2 pt-3">
                                <Label htmlFor="bc-batch">Lead upload</Label>
                                {batches.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">
                                        No lead uploads yet. An admin distributes leads from Lead
                                        Distribution, and each upload then appears here.
                                    </p>
                                ) : (
                                    <>
                                        <select
                                            id="bc-batch"
                                            value={leadBatchId}
                                            onChange={(event) => setLeadBatchId(event.target.value)}
                                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                        >
                                            <option value="">Choose an upload…</option>
                                            {batches.map((batch) => (
                                                <option key={batch.id} value={batch.id}>
                                                    {batch.name} — {batch.myLeadCount.toLocaleString()} of your leads
                                                </option>
                                            ))}
                                        </select>
                                        <p className="text-xs text-muted-foreground">
                                            Only the leads distributed to you. Anyone you have already
                                            marked Interested or Not Interested, and anyone blocked, is
                                            left out automatically.
                                        </p>
                                    </>
                                )}
                            </TabsContent>

                            <TabsContent value="file" className="space-y-2 pt-3">
                                <Label htmlFor="bc-file">Recipient file (.xlsx, .xls or .csv)</Label>
                                <Input
                                    id="bc-file"
                                    type="file"
                                    accept=".xlsx,.xls,.csv"
                                    onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                                />
                                {file && <p className="text-xs text-muted-foreground">{file.name}</p>}
                                <p className="text-xs text-muted-foreground">
                                    A phone column is required. Every other column becomes a merge field, so a
                                    "firstName" header fills {'{{firstName}}'} automatically. Rows without an owner
                                    name ("Owners Name") are left out; {'{{ownerName}}'} inserts it.
                                </p>
                            </TabsContent>

                            <TabsContent value="manual" className="space-y-2 pt-3">
                                <Label htmlFor="bc-numbers">Phone numbers</Label>
                                <Textarea
                                    id="bc-numbers"
                                    value={manualNumbers}
                                    onChange={(event) => setManualNumbers(event.target.value)}
                                    rows={7}
                                    placeholder={'+15551234567\n+15559876543'}
                                />
                                <p className="text-xs text-muted-foreground">
                                    {manualList.length} number{manualList.length === 1 ? '' : 's'} · separate with new
                                    lines, commas or semicolons. Merge fields will be blank for these.
                                </p>
                            </TabsContent>
                        </Tabs>
                    )}

                    {step === 2 && (
                        <AudienceBreakdown preview={preview} isLoading={previewLoading} error={previewError} />
                    )}

                    {step === 3 && (
                        <div className="space-y-5">
                            <div className="rounded-lg border p-4 text-sm">
                                <p className="mb-2 font-medium">Review</p>
                                <dl className="grid gap-2 sm:grid-cols-2">
                                    <Row label="Campaign" value={name} />
                                    <Row
                                        label="Audience"
                                        value={
                                            source === 'clients'
                                                ? `${clientIds.length} CRM client${clientIds.length === 1 ? '' : 's'}`
                                                : source === 'batch'
                                                  ? selectedBatch
                                                      ? `${selectedBatch.name} (${selectedBatch.myLeadCount.toLocaleString()} leads)`
                                                      : 'No lead upload chosen'
                                                  : source === 'manual'
                                                    ? `${manualList.length} number${manualList.length === 1 ? '' : 's'}`
                                                    : (file?.name ?? 'spreadsheet')
                                        }
                                    />
                                    <Row label="Encoding" value={smsInfo.encodingLabel} />
                                    <Row label="Credits per recipient" value={String(smsInfo.credits)} />
                                    {audienceCount != null && audienceCount > 0 && (
                                        <Row
                                            label="Estimated total credits"
                                            value={(audienceCount * smsInfo.credits).toLocaleString()}
                                        />
                                    )}
                                    <Row label="Merge fields" value={mergeTokens.join(', ') || 'none'} />
                                </dl>

                                <p className="mt-3 whitespace-pre-wrap rounded bg-muted p-2 text-xs">{body}</p>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-1">
                                    <Label htmlFor="bc-throttle">Messages per second</Label>
                                    <Input
                                        id="bc-throttle"
                                        type="number"
                                        min={1}
                                        value={throttle}
                                        onChange={(event) => setThrottle(event.target.value)}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Per-campaign limit. The account-wide limit still applies on top.
                                    </p>
                                </div>

                                <div className="space-y-1">
                                    <Label htmlFor="bc-schedule">Schedule (optional)</Label>
                                    {sendWindows.length > 0 && (
                                        <select
                                            value={sendWindowId}
                                            onChange={(event) => {
                                                setSendWindowId(event.target.value);
                                                // The two controls mean the same thing; keeping
                                                // both filled in would leave the operator unsure
                                                // which one the campaign actually used.
                                                if (event.target.value) setScheduledAt('');
                                            }}
                                            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                                        >
                                            <option value="">A specific time…</option>
                                            {sendWindows.map((window) => (
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
                                            id="bc-schedule"
                                            type="datetime-local"
                                            value={scheduledAt}
                                            onChange={(event) => setScheduledAt(event.target.value)}
                                        />
                                    )}
                                    <p className="text-xs text-muted-foreground">
                                        {sendWindowId
                                            ? 'Sends automatically at the next occurrence of that window.'
                                            : scheduledAt
                                              ? 'Sends automatically at this time.'
                                              : 'Leave empty to start the campaign by hand.'}
                                    </p>
                                </div>
                            </div>

                            <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800/50 dark:bg-amber-900/10">
                                <p className="flex items-center gap-2 font-medium text-amber-800 dark:text-amber-300">
                                    <AlertTriangle className="h-4 w-4" /> Before sending
                                </p>
                                <label className="flex items-start gap-2">
                                    <Checkbox
                                        checked={ackCompliance}
                                        onCheckedChange={(value: boolean | "indeterminate") => setAckCompliance(value === true)}
                                    />
                                    <span className="text-xs">
                                        These recipients consented to be contacted, and blocked, opted-out and DNC
                                        numbers will be skipped automatically.
                                    </span>
                                </label>
                                <label className="flex items-start gap-2">
                                    <Checkbox
                                        checked={ackIrreversible}
                                        onCheckedChange={(value: boolean | "indeterminate") => setAckIrreversible(value === true)}
                                    />
                                    <span className="text-xs">
                                        I understand messages already sent cannot be recalled — pausing only stops what
                                        has not gone out yet.
                                    </span>
                                </label>
                            </div>
                        </div>
                    )}
                </div>

                <div className="flex items-center justify-between border-t pt-3">
                    <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setStep((value) => Math.max(1, value - 1))}
                        disabled={step === 1 || isSubmitting}
                    >
                        <ArrowLeft className="mr-1 h-4 w-4" /> Back
                    </Button>

                    <div className="flex gap-2">
                        {step < TOTAL_STEPS ? (
                            <Button
                                type="button"
                                onClick={() => setStep((value) => value + 1)}
                                disabled={step === 1 ? !canLeaveStepOne : !canLeaveStepTwo}
                            >
                                Next <ArrowRight className="ml-1 h-4 w-4" />
                            </Button>
                        ) : (
                            <>
                                <Button variant="secondary" onClick={() => submit(false)} disabled={!canSubmit}>
                                    {isSubmitting ? (
                                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                                    ) : (
                                        <CheckCircle2 className="mr-1 h-4 w-4" />
                                    )}
                                    Save as draft
                                </Button>
                                <Button onClick={() => submit(true)} disabled={!canSubmit}>
                                    {isSubmitting ? (
                                        <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                                    ) : (
                                        <Send className="mr-1 h-4 w-4" />
                                    )}
                                    Create and send
                                </Button>
                            </>
                        )}
                    </div>
                </div>

                {step === 2 && audienceCount !== null && (
                    <p className="text-center text-xs text-muted-foreground">
                        {preview
                            ? `${preview.willSend.toLocaleString()} of ${preview.totalLeads.toLocaleString()} leads will receive this broadcast`
                            : `${audienceCount} recipient${audienceCount === 1 ? '' : 's'} selected`}
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
}

function StepIndicator({ current, total }: { current: number; total: number }) {
    return (
        <div className="flex items-center gap-3 border-y bg-muted/30 px-2 py-3">
            {Array.from({ length: total }, (_, index) => {
                const stepNumber = index + 1;
                const isActive = stepNumber === current;
                const isDone = stepNumber < current;

                return (
                    <div key={stepNumber} className="flex flex-1 items-center gap-2">
                        <div
                            className={cn(
                                'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-medium',
                                isActive && 'border-primary bg-primary text-primary-foreground',
                                isDone && 'border-emerald-600 bg-emerald-600 text-white',
                                !isActive && !isDone && 'border-muted-foreground/40 text-muted-foreground',
                            )}
                        >
                            {isDone ? <CheckCircle2 className="h-4 w-4" /> : stepNumber}
                        </div>
                        <span className={cn('text-xs', isActive ? 'font-medium' : 'text-muted-foreground')}>
                            {stepNumber === 1 ? 'Message' : stepNumber === 2 ? 'Audience' : 'Review'}
                        </span>
                        {stepNumber < total && <div className="h-px flex-1 bg-border" />}
                    </div>
                );
            })}
        </div>
    );
}

/**
 * Live message preview inside a real phone frame (`/mobile.png`, carried over
 * from Fivra).
 *
 * The PNG's screen area is fully transparent, so the conversation is rendered
 * in a layer *behind* the image and shows through the cut-out — no clip-path
 * and no fragile overlay. The inset percentages below were measured from the
 * asset itself: a 346 × 714 image whose screen window is x 16–328, y 16–698.
 * Keep them in step if the image is ever replaced.
 */
const PHONE_SCREEN_INSET = {
    top: '2.24%',
    right: '4.91%',
    bottom: '2.10%',
    left: '4.62%',
};

function PhonePreview({ body }: { body: string }) {
    const now = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    return (
        <div className="flex flex-col items-center">
            {/* aspect-ratio matches the asset so the inset percentages hold at any width */}
            <div className="relative w-full max-w-[250px]" style={{ aspectRatio: '346 / 714' }}>
                {/* Screen content — sits behind the frame, visible through the cut-out */}
                <div
                    className="absolute overflow-hidden rounded-[11%/5%] bg-white dark:bg-neutral-900"
                    style={PHONE_SCREEN_INSET}
                >
                    <div className="flex h-full flex-col">
                        {/* Status bar */}
                        <div className="flex items-center justify-between px-3 pt-[9%] pb-1 text-[9px] font-semibold text-neutral-900 dark:text-neutral-100">
                            <span>{now}</span>
                            <span className="flex items-center gap-1">
                                <Signal className="h-2.5 w-2.5" />
                                <BatteryFull className="h-3 w-3" />
                            </span>
                        </div>

                        {/* Conversation header */}
                        <div className="flex items-center gap-1.5 border-b border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
                            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-300 text-[8px] font-semibold text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
                                M
                            </div>
                            <div className="leading-tight">
                                <p className="text-[9px] font-semibold text-neutral-900 dark:text-neutral-100">
                                    Merchant
                                </p>
                                <p className="text-[8px] text-neutral-500">SMS</p>
                            </div>
                        </div>

                        {/* Messages */}
                        <div className="flex-1 space-y-2 overflow-y-auto px-2 py-2">
                            {body.trim() ? (
                                <>
                                    <div className="flex justify-end">
                                        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[#1a84ff] px-2.5 py-1.5">
                                            <p className="whitespace-pre-wrap break-words text-[10px] leading-snug text-white">
                                                {body}
                                            </p>
                                        </div>
                                    </div>
                                    <p className="pr-1 text-right text-[8px] text-neutral-400">Delivered</p>
                                </>
                            ) : (
                                <p className="px-2 pt-6 text-center text-[10px] text-neutral-400">
                                    Your message will appear here
                                </p>
                            )}
                        </div>

                        {/* Inert composer */}
                        <div className="flex items-center gap-1.5 border-t border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
                            <div className="flex-1 rounded-full bg-neutral-100 px-2 py-1 text-[9px] text-neutral-400 dark:bg-neutral-800">
                                Text message
                            </div>
                            <div className="flex h-4 w-4 items-center justify-center rounded-full bg-[#1a84ff]">
                                <ArrowUp className="h-2.5 w-2.5 text-white" />
                            </div>
                        </div>
                    </div>
                </div>

                {/* The phone itself, drawn on top */}
                <img
                    src="/mobile.png"
                    alt=""
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 h-full w-full select-none"
                />
            </div>

            <p className="mt-2 text-[11px] text-muted-foreground">Preview — merge fields shown unresolved</p>
        </div>
    );
}

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-sm">{value || '—'}</dd>
        </div>
    );
}

export default CreateBroadcastModal;
