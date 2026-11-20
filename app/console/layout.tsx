import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_NAME, verifySellerSession } from "@/lib/seller/session";

export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  if (!verifySellerSession(cookieStore.get(COOKIE_NAME)?.value)) {
    redirect("/login?next=%2Fconsole");
  }
  return children;
}
