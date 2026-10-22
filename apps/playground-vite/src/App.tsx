import { useTranslation } from "react-i18next";
import { LoginCard } from "./features/auth/LoginCard";

const user = { name: "Ada" };

export function Dashboard() {
  return (
    <section>
      <h1 id="hardcoded-title">Welcome back!</h1>
      <p id="dynamic">Welcome, {user.name}!</p>
      <input id="email" placeholder="Email address" />
      <button id="dup-a">Save</button>
      <button id="dup-b">Save</button>
    </section>
  );
}

export function App() {
  const { t } = useTranslation();
  return (
    <main>
      <h2 id="translated">{t("home.title")}</h2>
      <Dashboard />
      <LoginCard />
    </main>
  );
}
