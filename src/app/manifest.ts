import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "KcalCue — 卡路里範圍估算",
    short_name: "KcalCue",
    description: "透過食物相片了解大概卡路里同主要營養素範圍。",
    start_url: "/",
    display: "standalone",
    background_color: "#f7f4ed",
    theme_color: "#f7f4ed",
    lang: "zh-HK",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
