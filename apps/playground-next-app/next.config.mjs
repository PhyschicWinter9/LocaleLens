import createNextIntlPlugin from "next-intl/plugin";
import { withLocaleLens } from "@localelens/next";

const withNextIntl = createNextIntlPlugin();

// LocaleLens only acts in `next dev`; `next build` output is untouched.
export default withLocaleLens(withNextIntl({}));
