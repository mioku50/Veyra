import type { Metadata } from "next";
import { MetropolisPrototype } from "./prototype";

export const metadata:Metadata = {title:"Metropolis · Monad passkey prototype",robots:{index:false,follow:false}};
export default function MetropolisPage() { return <MetropolisPrototype />; }
