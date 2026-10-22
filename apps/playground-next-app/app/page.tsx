import { getTranslations } from "next-intl/server";
import { Counter } from "../components/Counter";

export default async function HomePage() {
  const t = await getTranslations("Home");

  return (
    <main>
      <h1 id="srv-title">{t("title")}</h1>
      <p id="srv-hardcoded">Server hardcoded text</p>
      <Counter />
    </main>
  );
}
