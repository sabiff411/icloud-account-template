export default function LocalNav() {
  return (
    <nav
      id="ac-localnav"
      aria-label="Local"
      className="sticky top-0 z-10 h-[52px] bg-white text-left max-[833px]:h-[48px]"
    >
      <div className="relative mx-auto h-full max-w-[1024px] px-[22px] max-[833px]:max-w-[980px] max-[833px]:px-4">
        <div className="flex h-full items-center justify-between">
          <div className="flex h-full items-center">
            <a
              href="#"
              className="flex items-center font-display opacity-[0.88] text-[21px] font-semibold leading-[24px] tracking-[0.231px] text-black max-[833px]:text-[19px] max-[833px]:tracking-[0.228px]"
            >
              Apple&nbsp;Account
            </a>
          </div>
          <div className="flex h-full items-center max-[833px]:hidden">
            <span className="ml-[24px] inline-block text-[12px] leading-[22px] tracking-[-0.12px] text-black opacity-[0.56]">
              Sign In
            </span>
            <a
              href="#"
              className="ml-[24px] inline-block whitespace-nowrap text-[12px] leading-[22px] tracking-[-0.12px] text-black opacity-[0.88] hover:text-[#0066cc]"
            >
              Create Your Apple&nbsp;Account
            </a>
            <a
              href="#"
              className="ml-[24px] inline-block text-[12px] leading-[22px] tracking-[-0.12px] text-black opacity-[0.88] hover:text-[#0066cc]"
            >
              FAQ
            </a>
          </div>
        </div>
        <button
          type="button"
          aria-label="Open Menu"
          className="absolute right-[11px] top-[14px] hidden h-[30px] w-[40px] items-center justify-center text-[#1d1d1f] max-[833px]:flex"
        >
          <span className="relative block h-[30px] w-[40px] opacity-80">
            <i className="absolute left-[9px] top-[13px] h-px w-[11px] bg-black [transform-origin:11px_1px] [transform:matrix(0.766044,0.642788,-0.707066,0.842649,0,0)]" />
            <i className="absolute left-[20px] top-[13px] h-px w-[11px] bg-black [transform-origin:0px_1px] [transform:matrix(0.766044,-0.642788,0.707066,0.842649,0,0)]" />
          </span>
        </button>
      </div>
      <div className="pointer-events-none absolute -bottom-px left-0 right-0 h-px bg-[rgba(0,0,0,0.16)] min-[1068px]:left-1/2 min-[1068px]:right-auto min-[1068px]:w-[980px] min-[1068px]:-translate-x-1/2" />
    </nav>
  );
}
