import NextImage from "next/image";
import Legacy from "next/legacy/image";
import { forwardRef, memo } from "react";

export const Card = memo(() => <NextImage src="/a.png" width={1} height={1}></NextImage>);

export const Tile = forwardRef(function Tile(props, ref) {
  return <NextImage src="/b.png" width={1} height={1} sizes="10vw" quality={60} />;
});

export class Gallery extends Component {
  render() {
    return <NextImage src="/c.png" width={1} height={1} />;
  }
}

export function Legacyish() {
  return <Legacy src="/d.png" width={1} height={1} />;
}
