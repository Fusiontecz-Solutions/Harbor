import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  analyzeSmsText,
  canConvertToSmsSafeText,
  convertToSmsSafeText,
  type SmsSegmentInfo,
} from '@/lib/smsSegments';
import { cn } from '@/lib/utils';

type SmsComposeMeterProps = {
  text: string;
  className?: string;
  /** When set, show recipients × credits estimate */
  recipientCount?: number | null;
  onTextChange?: (next: string) => void;
  /** Shown under the meter on broadcast compose (step 1). */
  showCampaignCreditHint?: boolean;
};

export function useSmsSegmentInfo(text: string): SmsSegmentInfo {
  return analyzeSmsText(text);
}

function segmentLabel(count: number): string {
  return `${count} Segment${count === 1 ? '' : 's'}`;
}

function creditLabel(count: number): string {
  return `${count} Credit${count === 1 ? '' : 's'}`;
}

export function SmsComposeMeter({
  text,
  className,
  recipientCount,
  onTextChange,
  showCampaignCreditHint = false,
}: SmsComposeMeterProps) {
  const info = useSmsSegmentInfo(text);
  const totalCredits =
    recipientCount != null && recipientCount > 0 ? recipientCount * info.credits : null;

  const showConvert = Boolean(onTextChange);
  const convertEnabled = showConvert && canConvertToSmsSafeText(text);

  const handleConvert = () => {
    if (!onTextChange) return;
    onTextChange(convertToSmsSafeText(text));
  };

  return (
    <div className={cn('space-y-2 text-xs', className)}>
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/80 bg-muted/30 px-2.5 py-2"
      >
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{info.characters}</span> Characters |{' '}
          <span className="font-medium text-foreground">{info.encodingLabel}</span> |{' '}
          <span className="font-medium text-foreground">{segmentLabel(info.segments)}</span> |{' '}
          <span className="font-medium text-foreground">{creditLabel(info.credits)}</span>
          <span className="text-muted-foreground"> per recipient</span>
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

        {showConvert && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 shrink-0 text-[11px]"
            disabled={!convertEnabled}
            onClick={handleConvert}
          >
            Convert to SMS-Safe Text
          </Button>
        )}
      </div>

      {showCampaignCreditHint && (
        <p className="text-[11px] text-muted-foreground">
          Select lead lists below to see total estimated credits. Final billing also uses longest
          lead placeholder values.
        </p>
      )}

      {info.isUnicode && (
        <div
          className="rounded-md border border-amber-300/80 bg-amber-50 px-2.5 py-2 text-amber-900 dark:border-amber-800/50 dark:bg-amber-900/15 dark:text-amber-200"
          role="status"
        >
          <p className="flex items-start gap-1.5 font-medium">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Unicode characters detected. This message uses UCS-2 encoding and costs more SMS credits
            than GSM-7. Use &quot;Convert to SMS-Safe Text&quot; to remove smart punctuation and
            emoji where possible.
          </p>
          {info.unicodeTriggers.length > 0 && (
            <p className="mt-1 text-[11px] opacity-90">
              Unicode detected: {info.unicodeTriggers.slice(0, 12).join(' ')}
              {info.unicodeTriggers.length > 12 ? ' …' : ''}
            </p>
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
    lines.push(
      `${recipients.toLocaleString()} recipients × ${info.segments} segments ≈ ${total.toLocaleString()} SMS credits.`,
    );
  }
  lines.push('Send anyway?');
  return window.confirm(lines.join('\n\n'));
}
