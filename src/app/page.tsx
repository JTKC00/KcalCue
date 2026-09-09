import { MealJournal } from "@/components/meal-journal";
import { getFoodVisionProviderMode } from "@/lib/providers/food-vision/factory";

export const dynamic = "force-dynamic";

export default function HomePage() {
  return <MealJournal initialProviderMode={getFoodVisionProviderMode()} />;
}
