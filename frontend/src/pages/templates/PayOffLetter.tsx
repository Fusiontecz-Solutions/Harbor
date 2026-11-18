import { createHtmlTemplatePreview } from "./HtmlTemplatePreview";
import {
  PAY_OFF_LETTER_VARIABLES,
  renderPayOffLetterEmailHtml,
} from "./payOffLetterEmailHtml";

export { PAY_OFF_LETTER_VARIABLES };

/** Fixed line under the sender name in legacy Alliance letter (kept for shared import). */
export const PAY_OFF_LETTER_SIGNATURE_TITLE = "Account Specialist";

/** In-app preview renders the exact outbound HTML so preview and email match. */
const PayOffLetter = createHtmlTemplatePreview(
  renderPayOffLetterEmailHtml,
  "Payoff letter preview",
);

export default PayOffLetter;
