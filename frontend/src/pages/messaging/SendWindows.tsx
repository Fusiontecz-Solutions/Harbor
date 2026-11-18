/**
 * Admin screen: the daily times broadcasts may be scheduled into.
 *
 * Harbor ships with 10:00, 13:30 and 16:30 Eastern, which is how the desk
 * already works — but a send time is an operational decision, not a property
 * of the code, so it is editable here rather than being a constant that needs
 * a deploy to move.
 *
 * Times are local to the chosen zone, not UTC. "16:30 America/New_York" stays
 * 4:30pm in New York across daylight saving; storing an offset instead would
 * quietly shift every campaign by an hour twice a year.
 */
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { Clock, Loader2, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
    deleteSendWindow,
    fetchSendWindows,
    saveSendWindow,
    type SendWindow,
} from '@/services/messaging/messagingApi';

/** The zones this business actually operates in. */
const TIMEZONES = [
    'America/New_York',
    'America/Chicago',
    'America/Denver',
    'America/Los_Angeles',
];

/** "16:30" → "4:30 PM", so the table reads the way an operator says it. */
function to12Hour(timeOfDay: string): string {
    const [rawHours, minutes] = timeOfDay.split(':');
    const hours = Number(rawHours);
    const suffix = hours >= 12 ? 'PM' : 'AM';
    const display = hours % 12 === 0 ? 12 : hours % 12;
    return `${display}:${minutes} ${suffix}`;
}

export default function SendWindows() {
    const [windows, setWindows] = useState<SendWindow[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);

    const [label, setLabel] = useState('');
    const [timeOfDay, setTimeOfDay] = useState('10:00');
    const [timezone, setTimezone] = useState(TIMEZONES[0]);

    const load = useCallback(async () => {
        setIsLoading(true);
        try {
            setWindows(await fetchSendWindows());
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to load send windows');
        } finally {
            setIsLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const add = useCallback(async () => {
        setIsSaving(true);
        try {
            await saveSendWindow({
                label: label.trim() || null,
                timeOfDay,
                timezone,
                sortOrder: windows.length,
            });
            setLabel('');
            await load();
            toast.success('Send window saved');
        } catch (error: any) {
            toast.error(error?.response?.data?.message || 'Failed to save send window');
        } finally {
            setIsSaving(false);
        }
    }, [label, load, timeOfDay, timezone, windows.length]);

    /**
     * Deactivating rather than deleting is the safer default, so this toggle is
     * the primary control — a window nobody schedules into does no harm, while
     * deleting one loses the label and ordering for good.
     */
    const toggleActive = useCallback(
        async (window: SendWindow) => {
            try {
                await saveSendWindow({
                    id: window.id,
                    label: window.label,
                    timeOfDay: window.timeOfDay,
                    timezone: window.timezone,
                    isActive: !window.isActive,
                    sortOrder: window.sortOrder,
                });
                await load();
            } catch (error: any) {
                toast.error(error?.response?.data?.message || 'Failed to update send window');
            }
        },
        [load],
    );

    const remove = useCallback(
        async (window: SendWindow) => {
            try {
                await deleteSendWindow(window.id);
                await load();
                toast.success('Send window removed');
            } catch (error: any) {
                toast.error(error?.response?.data?.message || 'Failed to remove send window');
            }
        },
        [load],
    );

    return (
        <div className="space-y-6 p-4">
            <div>
                <h1 className="text-lg font-semibold">Send windows</h1>
                <p className="text-sm text-muted-foreground">
                    The daily times a broadcast can be scheduled into. A campaign scheduled into a
                    window sends automatically at its next occurrence — nobody has to start it by
                    hand.
                </p>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Add a window</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1.5">
                        <Label htmlFor="sw-label" className="text-xs">
                            Label
                        </Label>
                        <Input
                            id="sw-label"
                            value={label}
                            onChange={(event) => setLabel(event.target.value)}
                            placeholder="Morning"
                            className="h-9 w-40"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="sw-time" className="text-xs">
                            Time
                        </Label>
                        <Input
                            id="sw-time"
                            type="time"
                            value={timeOfDay}
                            onChange={(event) => setTimeOfDay(event.target.value)}
                            className="h-9 w-32"
                        />
                    </div>
                    <div className="space-y-1.5">
                        <Label htmlFor="sw-tz" className="text-xs">
                            Time zone
                        </Label>
                        <select
                            id="sw-tz"
                            value={timezone}
                            onChange={(event) => setTimezone(event.target.value)}
                            className="h-9 rounded-md border bg-background px-2 text-sm"
                        >
                            {TIMEZONES.map((zone) => (
                                <option key={zone} value={zone}>
                                    {zone.split('/')[1].replace(/_/g, ' ')}
                                </option>
                            ))}
                        </select>
                    </div>
                    <Button onClick={add} disabled={isSaving}>
                        {isSaving ? (
                            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                        ) : (
                            <Plus className="mr-1 h-4 w-4" />
                        )}
                        Add
                    </Button>
                </CardContent>
            </Card>

            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Configured windows</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                    {isLoading ? (
                        <p className="py-4 text-sm text-muted-foreground">Loading…</p>
                    ) : windows.length === 0 ? (
                        <p className="py-4 text-sm text-muted-foreground">
                            No send windows. Add one above, or campaigns can only be scheduled to a
                            specific time.
                        </p>
                    ) : (
                        windows.map((window) => (
                            <div
                                key={window.id}
                                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
                            >
                                <div className="flex min-w-0 items-center gap-3">
                                    <Clock className="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-medium">
                                            {to12Hour(window.timeOfDay)}
                                            {window.label ? ` · ${window.label}` : ''}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {window.timezone.replace(/_/g, ' ')}
                                        </p>
                                    </div>
                                </div>

                                <div className="flex shrink-0 items-center gap-2">
                                    <Badge variant={window.isActive ? 'secondary' : 'outline'}>
                                        {window.isActive ? 'Active' : 'Paused'}
                                    </Badge>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        onClick={() => toggleActive(window)}
                                    >
                                        {window.isActive ? 'Pause' : 'Activate'}
                                    </Button>
                                    <Button
                                        size="icon"
                                        variant="ghost"
                                        className="h-8 w-8 text-muted-foreground hover:text-red-500"
                                        onClick={() => remove(window)}
                                        title="Remove this window"
                                    >
                                        <Trash2 className="h-4 w-4" />
                                    </Button>
                                </div>
                            </div>
                        ))
                    )}
                </CardContent>
            </Card>
        </div>
    );
}
