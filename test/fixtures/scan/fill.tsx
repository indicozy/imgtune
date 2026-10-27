import Image from "next/image";
import hero from "./hero.png";

export function Banner() {
  return <Image src={hero} fill alt="" />;
}
