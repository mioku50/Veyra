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

import type { NextConfig } from "next";

/* The browser test suites drive the dev server over 127.0.0.1, which Next treats
   as a cross-origin request and answers with 403 for every asset -- the page
   renders its server markup, never hydrates, and the suites time out waiting
   for a client-rendered heading. That looks exactly like a broken page and is
   not one, so the origin is allowed here rather than being rediscovered from
   console noise every time someone runs them. Development only. */
const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
