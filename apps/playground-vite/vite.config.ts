import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import localelens from "@localelens/vite";

// LocaleLens only transforms during `vite dev`; `vite build` output is untouched.
export default defineConfig({ plugins: [localelens(), react()] });
