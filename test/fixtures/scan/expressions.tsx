import Image from "next/image";

export function Hero({ mobile, q }) {
  return <Image src="/a.png" width={100} height={100} sizes={mobile ? "50vw" : "20vw"} quality={q} />;
}
