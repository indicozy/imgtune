// Fixture for locate on a production build. A fake React fiber chain (no React): the image's fiber returns to
// ProductCard, then Shop. The minified bundle keeps only function locations, which the source map maps back here.
function ProductCard(props) {
  const img = document.createElement("img");
  img.src = "/hero.jpg";
  img.width = 300;
  img.height = 200;
  img.alt = "Aviator";
  img.__reactFiber$fixture = { type: "img", return: { type: ProductCard, return: { type: Shop, return: null } } };
  props.root.append(img);
}

function Shop(root) {
  ProductCard({ root });
}

Shop(document.getElementById("root"));
