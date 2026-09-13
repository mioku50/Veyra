/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { redirect } from "next/navigation";

/** Nova moved to the front door. Kept so links and bookmarks still land. */
export default function NovaPage() {
  redirect("/");
}
