import { Fragment } from "react";

const LEGAL_LINKS = ["Privacy Policy", "Terms of Use", "Sales and Refunds", "Legal", "Site Map"];

function ShopLine({ compact = false }) {
  return (
    <div className={compact ? "pb-[10px]" : "pb-[3px]"}>
      More ways to shop: <a className="text-[#0066cc] hover:underline" href="#">Find an Apple Store</a> or{" "}
      <a className="text-[#0066cc] hover:underline" href="#">other retailer</a> near you.{" "}
      <span className="whitespace-nowrap">Or call 1-800-MY-APPLE.</span>
    </div>
  );
}

function Copyright({ compact = false }) {
  return (
    <div className={compact ? "mt-[5px]" : "mt-[5px] float-left mr-[30px]"}>
      Copyright © 2026 Apple Inc. All rights reserved.
    </div>
  );
}

function LegalLinks({ compact = false }) {
  return (
    <div className={compact ? "" : "float-left"}>
      {LEGAL_LINKS.map((label, i) => (
        <Fragment key={label}>
          {i > 0 ? " " : null}
          <a
            href="#"
            className="mr-[7px] mt-[5px] inline-block whitespace-nowrap border-r border-[#d2d2d7] pr-[10px] text-[#424245] last:mr-0 last:mt-[3px] last:border-r-0 last:pr-0 hover:underline"
          >
            {label}
          </a>
        </Fragment>
      ))}
    </div>
  );
}

function Locale({ compact = false }) {
  return (
    <div className={compact ? "-ml-px mt-[2px] h-[21px] pt-[5px]" : "float-right mt-[5px]"}>
      <a className="text-[#424245] hover:underline" href="#">
        United States
      </a>
    </div>
  );
}

export default function AppleFooter({ grayscaleText = false }) {
  return (
    <footer
      id="ac-globalfooter"
      className={`relative overflow-hidden bg-[#f5f5f7] font-text text-[12px] leading-[1.33337] tracking-normal text-[#6e6e73] ${
        grayscaleText ? "[&_div]:[transform:translateZ(0)] [&_a]:[transform:translateZ(0)] [&_span]:[transform:translateZ(0)]" : ""
      }`}
    >
      <div className="mx-auto max-w-[1024px] px-[22px] max-[833px]:max-w-[980px] max-[833px]:px-4">
        {/* Phone + tablet: the footer stacks (Apple switches this at 834px). */}
        <div className="pb-[22px] pt-[17px] min-[834px]:hidden">
          <ShopLine compact />
          <Locale compact />
          <div className="pb-[5px] pt-[12px]">
            <Copyright compact />
            <LegalLinks compact />
          </div>
        </div>

        {/* Desktop: one row of floats, so the links wrap naturally on narrow desktops. */}
        <div className="hidden pb-[24px] pt-[17px] min-[834px]:block">
          <ShopLine />
          <div className="relative -mt-[3px] pb-[5px]">
            <Locale />
            <Copyright />
            <LegalLinks />
            <div className="clear-both" />
          </div>
        </div>
      </div>
    </footer>
  );
}
