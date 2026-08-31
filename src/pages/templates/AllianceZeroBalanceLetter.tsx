import { createHtmlTemplatePreview } from "./HtmlTemplatePreview";
import {
  ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES,
  renderAllianceZeroBalanceLetterHtml,
} from "./Allicance_Zero_Balance_Letterhtml";

export { ALLIANCE_ZERO_BALANCE_LETTER_VARIABLES };

const AllianceZeroBalanceLetter = createHtmlTemplatePreview(
  renderAllianceZeroBalanceLetterHtml,
  "Clear Capital zero balance letter preview",
);

export default AllianceZeroBalanceLetter;
