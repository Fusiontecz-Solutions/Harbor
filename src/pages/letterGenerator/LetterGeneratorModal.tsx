import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useApplicationDetailLoader } from "@/hooks/useApplicationDetailLoader";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Letters from "@/pages/payment/Letters";
import { prefetchPaymentTemplates } from "@/pages/payment/paymentTemplateApi";
import { getApplicationBusinessDisplayName } from "@/lib/applicationBusinessDisplayName";

type LetterGeneratorModalProps = {
  applicationId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * Payoff / Zero Balance letter send UI in a modal (list stays on /letter-generator).
 */
export default function LetterGeneratorModal({
  applicationId,
  open,
  onOpenChange,
}: LetterGeneratorModalProps) {
  const id = open ? applicationId?.trim() || undefined : undefined;
  const { loading, data: applicationData, error } =
    useApplicationDetailLoader(id);

  useEffect(() => {
    if (open) prefetchPaymentTemplates();
  }, [open]);

  const ready = !!id && !loading && !!applicationData && !error;
  const dealLabel =
    applicationData?.applicationId != null
      ? `APP-${applicationData.applicationId}`
      : applicationData
        ? getApplicationBusinessDisplayName(applicationData)
        : "Application";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[min(94vh,calc(100dvh-1.5rem))] max-h-[min(94vh,calc(100dvh-1.5rem))] w-[min(100vw-1.5rem,1600px)] max-w-[98vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-[1600px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 px-5 py-4 text-left sm:px-6">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Letters
          </p>
          <DialogTitle className="text-lg font-semibold text-foreground">
            {dealLabel}
          </DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Choose Payoff or Zero Balance and send.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          {!id && (
            <p className="py-8 text-center text-destructive" role="alert">
              Invalid application. Close and pick another from the list.
            </p>
          )}

          {id && loading && !applicationData && (
            <div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin" />
              <span>Loading application…</span>
            </div>
          )}

          {id && error && !loading && (
            <p className="py-8 text-center text-destructive" role="alert">
              {error}
            </p>
          )}

          {ready && <Letters />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
