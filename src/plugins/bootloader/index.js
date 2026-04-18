export function main () {
  const { scriptUrl, preferencesJson } = ZenMoney.getPreferences()
  const preferences = JSON.parse(preferencesJson)
  ZenMoney.getPreferences = () => preferences
  fetchScript(scriptUrl)
    .then(
      res => onScriptResponse({ scriptUrl, status: res.status, body: res.body }),
      err => onScriptResponse({ scriptUrl, err })
    ).catch(err => {
      ZenMoney.setResult({ success: false, fatal: true, message: String(err) })
    })
}

async function fetchScript (scriptUrl) {
  let body
  let status
  if (typeof ZenMoney.fetch === 'function') {
    const response = await ZenMoney.fetch(scriptUrl)
    status = response.status
    body = await response.text()
  } else {
    body = ZenMoney.requestGet(scriptUrl)
    status = ZenMoney.getLastStatusCode()
  }
  return { body, status }
}

function onScriptResponse ({ scriptUrl, err, status, body }) {
  console.assert(!err, 'could not load script from url', scriptUrl, err)
  console.assert(status === 200, 'non-success status received for url', { status, scriptUrl, body })
  // eslint-disable-next-line no-eval
  eval(body)
  console.assert(global.main !== main, 'loaded script should override main function')
  global.main()
}
