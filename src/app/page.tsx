import { KcalCueApp } from "@/components/kcalcue-app";
import { getFoodVisionProviderMode } from "@/lib/providers/food-vision/factory";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return <KcalCueApp initialProviderMode={getFoodVisionProviderMode()} />;
}
