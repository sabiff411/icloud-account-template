import { useRef, useState } from "react";
import { Landing } from "../components/Landing";
import { termsHtml } from "../data/termsHtml";

export default function Terms({ onAgree }) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  function agree() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setTimeout(() => onAgree && onAgree(), 900);
  }

  return (
    <Landing hideRingsOnMobile>
      <div className="mx-auto mb-[50px] flex h-[calc(100dvh-232px)] min-h-[420px] w-full max-w-[460px] flex-col px-6 text-center max-[734px]:h-[calc(100dvh-190px)]">
        <h1 className="text-[24px] font-semibold leading-[28px] tracking-[-0.374px] text-[#1d1d1f] [transform:translateZ(0)]">
          Terms and Conditions
        </h1>
        <p className="mt-3 text-[17px] leading-[25px] tracking-[-0.374px] text-[#1d1d1f] [transform:translateZ(0)]">
          Please read the following terms before using your iOS device. By using your iOS device, you
          are agreeing to be bound by the iOS Terms and Conditions.
        </p>

        <div className="relative mb-[6px] mt-[9.6px] min-h-0 flex-1 overflow-y-auto rounded-[12px] border border-[#d2d2d7] bg-white px-[18px] py-4 text-left text-[12px] leading-[1.45] tracking-[-0.374px] text-[#1d1d1f] [direction:ltr]">
          <div dangerouslySetInnerHTML={{ __html: termsHtml }} />
          <div className="pointer-events-none sticky bottom-[-16px] -mt-[26px] h-[26px] bg-[linear-gradient(rgba(255,255,255,0),#fff_85%)]" />
        </div>

        <button
          type="button"
          onClick={agree}
          disabled={busy}
          className="mt-4 box-content h-12 w-full flex-none rounded-[12px] bg-[#0071e3] px-[15px] text-[17px] font-normal leading-[48px] tracking-normal text-white"
        >
          {busy ? (
            <span
              aria-hidden="true"
              className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[rgba(255,255,255,0.35)] border-t-white align-[-3px]"
            />
          ) : (
            "Agree and Update"
          )}
        </button>
      </div>
    </Landing>
  );
}
