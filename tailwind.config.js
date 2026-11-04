/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      fontFamily: {
        text: ['"SF Pro Text"', '"SF Pro Icons"', '"Helvetica Neue"', "Helvetica", "Arial", "sans-serif"],
        display: ['"SF Pro Display"', '"SF Pro Icons"', '"Helvetica Neue"', "Helvetica", "Arial", "sans-serif"],
      },
      keyframes: {
        "nib-fade": {
          "0%, to": { opacity: "0.55" },
          "1%": { opacity: "0.55" },
          "95%": { opacity: "0.08" },
        },
        "veil-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "rings-drift": {
          from: { transform: "scale(1) rotate(0deg)", opacity: "0.92" },
          "50%": { transform: "scale(1.035) rotate(1.2deg)", opacity: "1" },
          to: { transform: "scale(1.015) rotate(-1deg)", opacity: "0.95" },
        },
        "page-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "digit-pop": {
          "0%": { transform: "scale(1)" },
          "45%": { transform: "scale(1.08)" },
          "100%": { transform: "scale(1)" },
        },
        "step-in": {
          from: { opacity: "0", transform: "translateY(-4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        spin: { to: { transform: "rotate(360deg)" } },
      },
      animation: {
        "nib-fade": "nib-fade .8s linear infinite",
        "veil-in": "veil-in .16s ease-out .05s forwards",
        rings: "rings-drift 26s ease-in-out infinite alternate",
        "page-in": "page-in .5s ease-in-out both",
        "digit-pop": "digit-pop .18s ease-out",
        "step-in": "step-in .22s ease-out both",
      },
    },
  },
  plugins: [],
};
