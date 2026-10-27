import Image from "next/image";
import React, { forwardRef, memo, useMemo } from "react";

export function Grid({ items }) {
  const cards = items.map((i) => <Image src={i.url} width={1} height={1} />);
  const x = useMemo(() => <Image src="/m.png" width={1} height={1} />, []);
  return <div>{cards}{x}</div>;
}

export const Nested = memo(forwardRef(function Inner(props, ref) {
  return <Image src="/n.png" width={1} height={1} />;
}));

export const Wrapped = React.memo(() => <Image src="/w.png" width={1} height={1} />);
