import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { analyzeSmsText, convertToSmsSafeText, type SmsSegmentInfo } from '@/lib/smsSegments';
import { cn } from '@/lib/utils';

type SmsComposeMeterProps = {
  text: string;
  className?: string;
  /** When set, show recipients × credits estimate */
  recipientCount?: number | null;
  onTextChange?: (next: string) => void;
};

export function useSmsSegmentInfo(text: string): SmsSegmentInfo {
  return analyzeSmsText(text);
}

export function SmsComposeMeter({ text, className, recipientCount, onTextChange }: SmsComposeMeterProps) {
  const info = useSmsSegmentInfo(text);
  const totalCredits =
    recipientCount != null && recipientCount > 0
      ? recipientCount * info.credits
      : null;

  const canConvert =
    Boolean(onTextChange) &&
    info.isUnicode &&
    info.unicodeTriggers.some((ch) => /[“”‘’—–…]/.test(ch) || ch === '\u00A0');

  return (
    <div className={cn('space-y-2 text-xs', className)}>
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">{info.characters}</span> Characters |{' '}
        <span className="font-medium text-foreground">{info.encodingLabel}</span> |{' '}
        <span className="font-medium text-foreground">{info.segments}</span> Segment
        {info.segments === 1 ? '' : 's'} |{' '}
        <span className="font-medium text-foreground">{info.credits}</span> Credit
        {info.credits === 1 ? '' : 's'}
        {totalCredits != null && (
          <>
            {' '}
            ·{' '}
            <span className="font-medium text-foreground">
              {recipientCount!.toLocaleString()} Recipients × {info.credits} ={' '}
              {totalCredits.toLocaleString()} estimated SMS credits
            </span>
          </>
        )}
      </p>

      {info.isUnicode && (
        <div
          className="rounded-md border border-amber-300/80 bg-amber-50 px-2.5 py-2 text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/15 dark:text-amber-200"
          role="status"
        >
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Unicode characters detected. This message uses UCS-2 encoding and may require more SMS credits.
          </p>
          {info.unicodeTriggers.length > 0 && (
            <p className="mt-1 text-[11px] opacity-90">
              Unicode detected:{' '}
              {info.unicodeTriggers.slice(0, 12).join(' ')}
              {info.unicodeTriggers.length > 12 ? ' …' : ''}
            </p>
          )}
          {canConvert && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-[11px]"
              onClick={() => onTextChange!(convertToSmsSafeText(text))}
            >
              Convert to SMS-Safe Text
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function confirmMultiSegmentSend(info: SmsSegmentInfo, recipientCount: number | null): boolean {
  if (info.segments <= 1) return true;
  const recipients = recipientCount ?? 0;
  const total = recipients > 0 ? recipients * info.segments : null;
  const lines = [
    `This message will use ${info.segments} SMS credits per recipient because of its length or encoding.`,
  ];
  if (total != null) {
    lines.push(`${recipients.toLocaleString()} recipients × ${info.segments} segments ≈ ${total.toLocaleString()} SMS credits.`);
  }
  lines.push('Send anyway?');
  return window.confirm(lines.join('\n\n'));
}
