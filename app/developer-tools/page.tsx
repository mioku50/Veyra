import { redirect } from "next/navigation";

export default function LegacyDeveloperToolsPage() {
  redirect("/console/developer-tools");
}
