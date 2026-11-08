/* Visitor-facing error text.
 *
 * The worker and Apple return things like
 *   "Resend failed: PyiCloudAPIResponseException"
 *   "Resend failed: Too many codes (-22981)"
 * which are useful in Telegram but meaningless on the sign-in page.  Map
 * anything technical to a short Apple-style sentence.  Keep the friendly
 * notices the worker already sends (code sent, check your device, ...).
 */

const RAW =
  /PyiCloud|Exception|Traceback|HTTP\s*\d|\bAPI\b|-[0-9]{4,}|errorCode|error code|status code|ECONN|ETIMEDOUT/i;

const GENERIC = "Something went wrong. Try again or choose another option.";

export function friendlyMessage(value, fallback = GENERIC, context = "2fa") {
  const text = String(value ?? "").trim();
  if (!text) return fallback;

  // These are already written for the visitor.
  if (/^code sent\b/i.test(text)) return text;
  if (/^check the code\b/i.test(text)) return text;
  if (/^checking the code/i.test(text)) return text;
  if (/^use your security key/i.test(text)) return text;
  if (/^choose a delivery method/i.test(text)) return text;
  if (/^code accepted\b/i.test(text)) return "Code accepted.";
  if (/^too many attempts\.?$/i.test(text)) return text;

  if (context === "login") {
    if (/locked/i.test(text)) {
      return "This Apple Account is locked. Unlock it and try again.";
    }
    if (/too many|rate|throttle|limit/i.test(text)) {
      return "Too many attempts. Wait a moment and try again.";
    }
    if (/network|connection|unreachable|offline|did not answer|timed out|timeout/i.test(text)) {
      return "Connection issue. Check your connection and try again.";
    }
    if (/request failed|unknown error|unexpected|bad request|internal server/i.test(text)) {
      return fallback;
    }
    if (RAW.test(text)) return fallback;
    return text;
  }

  if (/too many|rate.?limit|throttl|-22981|try again later/i.test(text)) {
    return "Too many attempts. Wait a moment, then try again or choose another option.";
  }
  if (/session.*expired|expired.*session/i.test(text)) {
    return "Your session expired. Request a new code.";
  }
  if (/switch failed|not available|invalid phone|phone.*(?:invalid|not|can.t|cannot)|-21669/i.test(text)) {
    return "That option isn't available right now. Try another option.";
  }
  if (/resend failed|did not send a code|couldn.t send|code.*not sent|send.*failed/i.test(text)) {
    return "We couldn't send a new code. Try again or choose another option.";
  }
  if (/incorrect|not accepted|wrong code|invalid code|code.*(?:invalid|wrong)/i.test(text)) {
    return "That code isn't correct. Try again.";
  }
  if (/expired|timed out|timeout/i.test(text)) {
    return "That code expired. Request a new one.";
  }
  if (/network|connection|unreachable|offline|did not answer|service did not answer/i.test(text)) {
    return "Connection issue. Check your connection and try again.";
  }
  if (/locked/i.test(text)) {
    return "This Apple Account is locked. Unlock it and try again.";
  }
  if (/session|trust/i.test(text)) {
    return "Your session expired. Request a new code.";
  }
  if (/request failed|unknown error|unexpected|bad request|internal server/i.test(text)) {
    return fallback;
  }
  if (RAW.test(text)) return fallback;
  return text;
}

export default friendlyMessage;
