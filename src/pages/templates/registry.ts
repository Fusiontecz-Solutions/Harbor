import ApplicationApprovalEmail, {
  APPLICATION_APPROVAL_EMAIL_VARIABLES,
} from "./ApplicationApprovalEmail";
import { renderApplicationApprovalEmailHtml } from "./applicationApprovalEmailHtml";
import ApplicationApprovedEmail, {
  APPLICATION_APPROVED_EMAIL_VARIABLES,
} from "./ApplicationApprovedEmail";
import { renderApplicationApprovedEmailHtml } from "./applicationApprovedEmailHtml";
import ApplicationRejectionEmail, {
  APPLICATION_REJECTION_EMAIL_VARIABLES,
} from "./ApplicationRejectionEmail";
import { renderApplicationRejectionEmailHtml } from "./applicationRejectionEmailHtml";
import DocumentRequestEmail, {
  DOCUMENT_REQUEST_EMAIL_VARIABLES,
} from "./DocumentRequestEmail";
import { renderDocumentRequestEmailHtml } from "./documentRequestEmailHtml";
import OfferUpdatedEmail, {
  OFFER_UPDATED_EMAIL_VARIABLES,
} from "./OfferUpdatedEmail";
import { renderOfferUpdatedEmailHtml } from "./offerUpdatedEmailHtml";
import PayOffLetter, {
  PAY_OFF_LETTER_VARIABLES,
} from "./PayOffLetter";
import { renderPayOffLetterEmailHtml } from "./payOffLetterEmailHtml";
import AlliancePayoffLetter, {
  ALLIANCE_PAYOFF_LETTER_VARIABLES,
} from "./AlliancePayoffLetter";
import { renderAlliancePayoffLetterHtml } from "./Allicance_Payoff_Letterhtml";
import AllianceZeroBalanceLetter, {
  ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES,
} from "./AllianceZeroBalanceLetter";
import { renderAllianceZeroBalanceLetterHtml } from "./Allicance_Zero_Balance_Letterhtml";
import ZeroBalanceLetter, {
  ZERO_BALANCE_LETTER_VARIABLES,
} from "./ZeroBalanceLetter";
import { renderZeroBalanceLetterEmailHtml } from "./zeroBalanceLetterEmailHtml";
import type { TemplateCategory, TemplateDefinition, TemplateValues } from "./types";

/**
 * Central registry of every template in this folder. Add new templates here
 * so they automatically show up in the Template Playground (`/template/playground`).
 */
export const TEMPLATE_REGISTRY: TemplateDefinition[] = [
  {
    id: "application-rejection-email",
    name: "Application Rejection Email",
    category: "email",
    description:
      "Email sent to a client / ISO when an application is rejected during underwriting.",
    variables: APPLICATION_REJECTION_EMAIL_VARIABLES,
    Component: ApplicationRejectionEmail,
    renderHtml: renderApplicationRejectionEmailHtml,
  },
  {
    id: "document-request-email",
    name: "Document Request Email",
    category: "email",
    description:
      "Email sent to an ISO / client requesting documents be uploaded via the public portal.",
    variables: DOCUMENT_REQUEST_EMAIL_VARIABLES,
    Component: DocumentRequestEmail,
    renderHtml: renderDocumentRequestEmailHtml,
  },
  {
    id: "application-approval-email",
    name: "Application Approval Email",
    category: "email",
    description:
      "Email sent to an ISO / client when an application is pre-approved, with a link to calculate approvals.",
    variables: APPLICATION_APPROVAL_EMAIL_VARIABLES,
    Component: ApplicationApprovalEmail,
    renderHtml: renderApplicationApprovalEmailHtml,
  },
  {
    id: "application-approved-email",
    name: "Application Approved Email",
    category: "email",
    description:
      "Email sent when an application is approved, with full offer terms inline (no portal link).",
    variables: APPLICATION_APPROVED_EMAIL_VARIABLES,
    Component: ApplicationApprovedEmail,
    renderHtml: renderApplicationApprovedEmailHtml,
  },
  {
    id: "offer-updated-email",
    name: "Offer Updated Email",
    category: "email",
    description:
      "Email sent to an ISO / client when approved offer values are updated, with a link to review the new offer.",
    variables: OFFER_UPDATED_EMAIL_VARIABLES,
    Component: OfferUpdatedEmail,
    renderHtml: renderOfferUpdatedEmailHtml,
  },
  {
    id: "payoff-letter",
    name: "Payoff letter",
    category: "letter",
    description: "Payoff letter sent to a merchant with wire instructions.",
    variables: PAY_OFF_LETTER_VARIABLES,
    Component: PayOffLetter,
    renderHtml: renderPayOffLetterEmailHtml,
  },
  {
    id: "alliance-payoff-letter",
    name: "Clear Capital payoff letter",
    category: "letter",
    description: "Clear Capital payoff letter with wire instructions.",
    variables: ALLIANCE_PAYOFF_LETTER_VARIABLES,
    Component: AlliancePayoffLetter,
    renderHtml: renderAlliancePayoffLetterHtml,
  },
  {
    id: "alliance-zero-balance-letter",
    name: "Clear Capital zero balance letter",
    category: "letter",
    description: "Clear Capital zero balance / balance letter.",
    variables: ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES,
    Component: AllianceZeroBalanceLetter,
    renderHtml: renderAllianceZeroBalanceLetterHtml,
  },
  {
    id: "zero-balance-letter",
    name: "Zero balance letter",
    category: "letter",
    description: "Zero balance confirmation letter sent to a merchant.",
    variables: ZERO_BALANCE_LETTER_VARIABLES,
    Component: ZeroBalanceLetter,
    renderHtml: renderZeroBalanceLetterEmailHtml,
  },
];

export const BUILTIN_FE_TEMPLATE_ID_PREFIX = "builtin-fe:";

const BUILTIN_REACT_DEFINITIONS: TemplateDefinition[] = [
  {
    id: `${BUILTIN_FE_TEMPLATE_ID_PREFIX}payoff-letter`,
    name: "Payoff letter",
    category: "letter",
    description: "Payoff letter sent to a merchant with wire instructions.",
    variables: PAY_OFF_LETTER_VARIABLES,
    Component: PayOffLetter,
    renderHtml: renderPayOffLetterEmailHtml,
  },
  {
    id: `${BUILTIN_FE_TEMPLATE_ID_PREFIX}alliance-payoff-letter`,
    name: "Clear Capital payoff letter",
    category: "letter",
    description: "Clear Capital payoff letter with wire instructions.",
    variables: ALLIANCE_PAYOFF_LETTER_VARIABLES,
    Component: AlliancePayoffLetter,
    renderHtml: renderAlliancePayoffLetterHtml,
  },
  {
    id: `${BUILTIN_FE_TEMPLATE_ID_PREFIX}alliance-zero-balance-letter`,
    name: "Clear Capital zero balance letter",
    category: "letter",
    description: "Clear Capital zero balance / balance letter.",
    variables: ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES,
    Component: AllianceZeroBalanceLetter,
    renderHtml: renderAllianceZeroBalanceLetterHtml,
  },
  {
    id: `${BUILTIN_FE_TEMPLATE_ID_PREFIX}zero-balance-letter`,
    name: "Zero balance letter",
    category: "letter",
    variables: ZERO_BALANCE_LETTER_VARIABLES,
    Component: ZeroBalanceLetter,
    renderHtml: renderZeroBalanceLetterEmailHtml,
  },
];

const builtinById = new Map(
  BUILTIN_REACT_DEFINITIONS.map((d) => [d.id, d] as const),
);

export function getBuiltinReactTemplateDefinition(
  id: string | undefined | null,
): TemplateDefinition | undefined {
  if (!id) return undefined;
  return builtinById.get(id);
}

export function isBuiltinFeTemplate(id: string | undefined | null): boolean {
  return typeof id === "string" && id.startsWith(BUILTIN_FE_TEMPLATE_ID_PREFIX);
}

export function renderBuiltinReactTemplateHtml(
  id: string,
  values: Record<string, string>,
): string {
  const def = builtinById.get(id);
  if (def?.renderHtml) return def.renderHtml(values as TemplateValues);
  return "";
}

export type BuiltinPaymentTemplateRow = {
  id: string;
  name: string;
  category: TemplateCategory;
  variables: string[];
  body: string;
  status: string;
  createdAt?: string;
  updatedAt?: string;
};

const todayIso = (): string => new Date().toISOString();

export const BUILTIN_FE_TEMPLATES: BuiltinPaymentTemplateRow[] =
  BUILTIN_REACT_DEFINITIONS.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    variables: d.variables.map((v) => v.key),
    body: "",
    status: "active",
    createdAt: todayIso(),
    updatedAt: todayIso(),
  }));

export function mergeBuiltinFeTemplates(
  apiList: BuiltinPaymentTemplateRow[],
): BuiltinPaymentTemplateRow[] {
  const builtinNames = new Set(
    BUILTIN_FE_TEMPLATES.map((t) => t.name.trim().toLowerCase()),
  );
  const builtinIds = new Set(BUILTIN_FE_TEMPLATES.map((t) => t.id));
  const filteredApi = apiList.filter(
    (t) =>
      !builtinIds.has(t.id) &&
      !builtinNames.has((t.name ?? "").trim().toLowerCase()),
  );
  return [...BUILTIN_FE_TEMPLATES, ...filteredApi];
}
