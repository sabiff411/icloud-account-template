export function Rings({ hiddenOnMobile = false }) {
  return (
    <div
      aria-hidden="true"
      className={`relative mb-[-78px] h-[300px] w-[300px] [transform:scale(.6)_translateY(-105px)] max-[734px]:mb-[-80px] max-[734px]:h-[280px] max-[734px]:w-[280px] max-[734px]:[transform:scale(.6)_translateY(-98px)] ${
        hiddenOnMobile ? "max-[734px]:hidden" : ""
      }`}
    >
      <div className="absolute left-[150px] top-[-159px] h-[1618px] w-[1380px] [transform:translateX(-690px)] max-[734px]:left-[140px] max-[734px]:top-[-148.33px] max-[734px]:h-[1510.12px] max-[734px]:w-[1288px] max-[734px]:[transform:translateX(-644px)]">
        <div className="absolute inset-0 animate-rings bg-[url('/assets/rings.webp')] bg-[length:100%_100%] bg-no-repeat [will-change:transform]" />
      </div>
    </div>
  );
}

export function Landing({ children, hideRingsOnMobile = false }) {
  return (
    <div className="overflow-hidden pt-[60px]">
      <div className="relative flex flex-col items-center px-[90px] text-center max-[734px]:px-[30px]">
        <Rings hiddenOnMobile={hideRingsOnMobile} />
        <div className="relative w-full max-w-[980px] max-[734px]:w-screen max-[734px]:max-w-none">
          {children}
        </div>
      </div>
    </div>
  );
}
