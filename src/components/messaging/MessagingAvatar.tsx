/**
 * Conversation avatar.
 *
 * Ported from Fivra's inbox avatar: initials on a colour derived from the name,
 * so the same contact is always the same colour and a long thread list becomes
 * scannable without reading every row. Numbers with no name fall back to a
 * generic icon rather than showing meaningless digits as "initials".
 */
import { User } from 'lucide-react';
import { cn } from '@/lib/utils';

const PALETTE = [
    'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400',
    'bg-blue-600/15 text-blue-700 dark:text-blue-400',
    'bg-purple-600/15 text-purple-700 dark:text-purple-400',
    'bg-pink-600/15 text-pink-700 dark:text-pink-400',
    'bg-orange-600/15 text-orange-700 dark:text-orange-400',
    'bg-cyan-600/15 text-cyan-700 dark:text-cyan-400',
    'bg-indigo-600/15 text-indigo-700 dark:text-indigo-400',
    'bg-rose-600/15 text-rose-700 dark:text-rose-400',
];

const SIZES = {
    sm: 'h-7 w-7 text-[10px]',
    md: 'h-9 w-9 text-xs',
    lg: 'h-11 w-11 text-sm',
} as const;

/** Stable hash → palette index, so a contact keeps its colour across sessions. */
function colorFor(seed: string): string {
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) {
        hash = (hash << 5) - hash + seed.charCodeAt(i);
        hash &= hash;
    }
    return PALETTE[Math.abs(hash) % PALETTE.length];
}

function initialsOf(name: string): string {
    return name
        .split(/\s+/)
        .filter(Boolean)
        .map((part) => part[0])
        .slice(0, 2)
        .join('')
        .toUpperCase();
}

export function MessagingAvatar({
    name,
    size = 'md',
    className,
}: {
    name: string | null;
    size?: keyof typeof SIZES;
    className?: string;
}) {
    const label = (name ?? '').trim();
    // A "name" that is really a phone number has no useful initials.
    const isNumeric = !label || /^\+?[\d\s().-]+$/.test(label);

    if (isNumeric) {
        return (
            <div
                className={cn(
                    'flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground',
                    SIZES[size],
                    className,
                )}
            >
                <User className="h-1/2 w-1/2" />
            </div>
        );
    }

    return (
        <div
            className={cn(
                'flex shrink-0 items-center justify-center rounded-full font-semibold',
                SIZES[size],
                colorFor(label),
                className,
            )}
        >
            {initialsOf(label)}
        </div>
    );
}

export default MessagingAvatar;
