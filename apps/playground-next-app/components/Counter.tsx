"use client";

import { useState } from "react";

export function Counter() {
  const [n, setN] = useState(0);
  return (
    <div>
      <button id="client-hardcoded" onClick={() => setN(n + 1)}>Click me</button>
      <span id="count">{n}</span>
    </div>
  );
}
