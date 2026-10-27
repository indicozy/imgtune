import dynamic from "next/dynamic";

const Lazy = dynamic(() => import("@/components/Lazy"));

export default function HomePage() {
  return <Lazy />;
}
