const doDebug = false;

const postprocess = links =>
  links
    .filter(
      l =>
        !l.startsWith("https://scholar.google.com/") &&
        !l.startsWith("https://dl.acm.org/")
    )
    .map(l =>
      l
        .replace("https://arxiv.org/abs", "https://arxiv.org/pdf")
        .replace("https://openreview.net/forum", "https://openreview.net/pdf")
    );

async function fetchGoogleAPI(query) {
  const options = {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-User-Agent": "",
      "X-Proxy-Location": "",
      "X-Api-Key": "KNCQBvdgcZyVYvWGVboELXYD",
    },
  };

  const url = `https://api.serply.io/v1/search/q=${encodeURIComponent(query)}`;

  const response = await fetch(url, options);
  const data = await response.json();
  const links = data.results.map(r => r.link);
  return postprocess(links);
}

async function openInlineCitation(citation) {
  const { PDFViewerApplication } = window;
  const pdfDoc = PDFViewerApplication.pdfDocument;
  const destination = await pdfDoc.getDestination(decodeURIComponent(citation));
  if (!destination)
    throw new Error(decodeURIComponent(citation) + " is an invalid link");

  const loc = destination[0].num;
  const { name } = destination[1];

  let targetX = 0;
  let targetY = Infinity; // very very top of page
  if (name === "XYZ") {
    targetX = destination[2];
    targetY = destination[3];
  } else if (name === "FitH") {
    targetY = destination[2];
  } else {
    throw new Error("Unrecognized link!");
  }

  let rightPage = null;
  let nextPage = null;
  for (let pageId = 1; pageId <= pdfDoc.numPages; pageId++) {
    const page = await pdfDoc.getPage(pageId);
    if (page._pageInfo.ref.num === loc) {
      rightPage = page;
      if (pageId < pdfDoc.numPages) nextPage = await pdfDoc.getPage(pageId + 1);
      break;
    }
  }

  if (!rightPage) throw new Error("error, not found");

  const annotations = await rightPage.getAnnotations();
  const links = annotations.filter(annotation => annotation.subtype === "Link");

  const strippedContent = [
    await rightPage.getTextContent(),
    nextPage && (await nextPage.getTextContent()),
  ]
    .filter(c => c)
    .map(c => c.items)
    .reduce((agg, nxt) => [...agg, ...nxt], []);

  let firstMatchIdx = strippedContent.findIndex(
    (i, idx) =>
      i.transform[4] + i.width / 2 >= targetX &&
      i.transform[5] <= targetY &&
      i.transform[5] >= targetY - 15 &&
      // and is a newline
      // Prevents bugs with i.e. McAuley et al 2015 in the WT5 paper
      (idx === 0 ||
        Math.abs(i.transform[5] - strippedContent[idx - 1].transform[5]) >=
          i.height * 1.25 ||
        i.str.match(/\[\d+\]/))
  );

  if (firstMatchIdx < 0)
    throw new Error(
      "Couldn't find bibliography entry: " + JSON.stringify(destination)
    ); /*+" "+
        JSON.stringify(strippedContent.map(i=>({
            str:i.str,
            transform:i.transform,
            width:i.width,
            height:i.height
        })))
        )*/

  let lastMatchIdx = strippedContent.findIndex(
    (i, idx) =>
      idx > firstMatchIdx &&
      ((Math.abs(i.transform[5] - strippedContent[idx - 1].transform[5]) >=
        i.height * 1.25 &&
        // assume that every citation ends with a period.
        strippedContent[idx - 1].str.endsWith(".")) ||
        // but sometimes this isn't true (see Visual Instruction Tuning), so we also assume every [1] is a new citation
        i.str.match(/\[\d+\]/))
  );
  if (lastMatchIdx < 0) lastMatchIdx += strippedContent.length;

  const citationLink = strippedContent
    .slice(firstMatchIdx, lastMatchIdx)
    .map(i =>
      links.filter(({ rect, url }) => {
        const [xMin, yMin, xMax, yMax] = rect;
        const iCenterX = i.transform[4] + i.width / 2;
        const iCenterY = i.transform[5] + i.height / 2;

        return (
          url &&
          iCenterX >= xMin &&
          iCenterX <= xMax &&
          iCenterY >= yMin &&
          iCenterY <= yMax
        );
      })
    )
    .reduce((agg, nxt) => [...agg, ...nxt], [])[0];

  const citationText = strippedContent
    .slice(firstMatchIdx, lastMatchIdx)
    .map(i => i.str)
    .reduce(
      (agg, nxt) =>
        agg.endsWith("-") ? agg.slice(0, -1) + nxt : agg + " " + nxt,
      ""
    )
    .trim()
    // remove words with *no* letters
    .split(" ")
    .filter(w => w.match(/[a-zA-Z]/))
    .join(" ");

  try {
    let results;
    let url;
    if (citationLink) url = citationLink.url;
    else {
      results = await fetchGoogleAPI(citationText);

      url = results[0];
    }

    if (!url) throw new Error(`Found no results for "${citationText}"`);

    if (doDebug)
      alert(
        `${citation} ->\n${JSON.stringify(citationText)} ->\n${url} (from ${
          citationLink ? "metadata" : "Google"
        })${citationLink ? "" : "\n\n" + results.join("\n")}}`
      );

      console.log("URL",url)

      window.open(url, "_blank");

    // const addToLibrary = wrapInside(window.addToLibrary);

    // await addToLibrary(url, window.itemID);
  } catch (err) {
    alert(err + "\n" + err.stack);
  }
}


const watchedEls = new WeakSet();
window.citeListenersInterval = setInterval(() => {
  const as = Array.from(document.querySelectorAll("a")).filter(
    a => !watchedEls.has(a)
  );
  as.forEach(a => watchedEls.add(a));
  as.forEach(a => {
    const href = a.getAttribute("href");
    if (href?.includes("#")) {
      const tailEnd = href.split("#")[1];
      const oldOnClick = a.onclick;

      if (doDebug) a.style.border = "1px solid purple";


      a.onclick = evt => {
        if (evt.metaKey || evt.ctrlKey) {
          (async () => {
            try {
              await openInlineCitation(tailEnd);
            } catch (err) {
              alert(err);
            }
          })();
          evt.preventDefault();
          evt.stopPropagation();
          return false;
        }
        return oldOnClick.call(this, evt);
      };
      return tailEnd;
    }

      if (doDebug) a.style.border = "1px solid orange";
  });
}, 500);
