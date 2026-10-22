import { useTranslation } from "react-i18next";

export default function Home() {
  const { t } = useTranslation();

  return (
    <main>
      <h1 id="pg-title">{t("home.title")}</h1>
      <p id="pg-hardcoded">Pages hardcoded text</p>
      <input id="pg-email" placeholder="Email address" />
    </main>
  );
}
