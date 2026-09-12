/**
 * Copyright 2026 Veyra
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { cookies } from "next/headers";
import type React from "react";
import { CommandCenterLayout } from "@/components/layout/layout";
import { COOKIE_NAME, verifySellerSession } from "@/lib/seller/session";

export async function GlobalNav({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const loggedIn = verifySellerSession(cookieStore.get(COOKIE_NAME)?.value);

  return <CommandCenterLayout loggedIn={loggedIn}>{children}</CommandCenterLayout>;
}
