import { Landing } from "../components/Landing";
import { CheckBadge } from "../components/Icons";

export default function Done({ onContinue }) {
  return (
    <Landing>
      <div className="mb-[50px] flex min-h-[60vh] items-center justify-center pb-[10px] pt-[28px] max-[734px]:min-h-[60vh]">
        <div className="mx-auto w-full max-w-[440px] px-[22px] text-center">
          <div className="rounded-[20px] border border-[rgba(0,0,0,0.05)] bg-white px-[26px] pb-[24px] pt-[36px] text-center shadow-[0_6px_28px_rgba(0,0,0,0.07)]">
            <div className="mx-auto mb-5 h-16 w-16" aria-hidden="true">
              <CheckBadge />
            </div>
            <h1 className="text-[26px] font-semibold leading-[32px] tracking-[-0.2px] text-[#1d1d1f]">
              Update Complete
            </h1>
            <p className="mt-[12.8px] text-[16px] leading-[23px] tracking-[-0.374px] text-[#424245]">
              Your Apple Account is up to date and ready to use on this device.
            </p>
            <button
              type="button"
              onClick={onContinue}
              className="mt-[38.6px] h-[46px] w-full rounded-[12px] bg-transparent text-[17px] font-medium leading-[46px] tracking-normal text-white"
            >
              Continue
            </button>
            <p className="text-[12px] leading-[17px] tracking-[-0.374px] text-[#86868b]">
              A copy of the updated Terms and Conditions has been sent to your email.
            </p>
          </div>
        </div>
      </div>
    </Landing>
  );
}
