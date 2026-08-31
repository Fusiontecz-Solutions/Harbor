import { createHtmlTemplatePreview } from "./HtmlTemplatePreview";
import {
  ALLIANCE_PAYOFF_LETTER_VARIABLES,
  renderAlliancePayoffLetterHtml,
} from "./Allicance_Payoff_Letterhtml";

export { ALLIANCE_PAYOFF_LETTER_VARIABLES };

const AlliancePayoffLetter = createHtmlTemplatePreview(
  renderAlliancePayoffLetterHtml,
  "Clear Capital payoff letter preview",
);

export default AlliancePayoffLetter;
