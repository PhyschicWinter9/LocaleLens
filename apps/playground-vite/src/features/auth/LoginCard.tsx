import { useTranslation } from "react-i18next";

export function LoginCard() {
  const { t } = useTranslation("auth");
  return (
    <form id="login">
      <h3 id="login-title">{t("login.title")}</h3>
      <button type="submit">{t("login.submit")}</button>
    </form>
  );
}
