import { defaultsDeep } from 'lodash'
import forge from 'node-forge'
import { stringify } from 'querystring'
import { getByteStringFromString } from '../../common/byteStringUtils'
import { toISODateString } from '../../common/dateUtils'
import { fetchJson } from '../../common/network'
import { generateUUID } from '../../common/utils'
import { BankMessageError, InvalidLoginOrPasswordError, InvalidOtpCodeError, TemporaryUnavailableError } from '../../errors'

const host = 'www.sber-bank.by'
const defaultKeyValueSeparator = ':'

export class AuthError {}

export function getAuthToken ({ login, password }) {
  return 'Basic ' + forge.util.encode64(getByteStringFromString(login) + defaultKeyValueSeparator + getByteStringFromString(password))
}

export function generateDevice (device) {
  if (!device) {
    return {
      androidId: generateUUID().split('-').join('').substring(0, 16),
      udid: generateUUID()
    }
  } else {
    return {
      androidId: device.androidId,
      udid: device.udid
    }
  }
}

async function callGate (url, options = {}) {
  const headers = {
    ...options.headers,
    Accept: 'application/json; charset=UTF-8',
    'X-Sbol-OS': 'android',
    'X-Sbol-Version': '3.8.3',
    'X-Sbol-Id': options.device.androidId,
    'User-Agent': 'sbol/3.8.3 (android 8.0.0) ' + ZenMoney.device.model,
    Host: host,
    Connection: 'Keep-Alive',
    'Accept-Encoding': 'gzip'
  }

  const response = await fetchJson(url, {
    stringify,
    ...options,
    headers,
    sanitizeRequestLog: defaultsDeep({ headers: { 'X-Sbol-Id': true } }, options && options.sanitizeRequestLog),
    sanitizeResponseLog: defaultsDeep({ body: { access_token: true, refresh_token: true } }, options && options.sanitizeResponseLog)
  })
  if (response.body && response.body.errorInfo && response.body.errorInfo.errorCode === '1') {
    throw new TemporaryUnavailableError() // Сервис временно недоступен
  }
  return response
}

async function prepareDevice (device) {
  return callGate(`https://${host}/SBOLServer/rest/registration/prepareDevice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8'
    },
    body: {
      udId: device.udid
    },
    sanitizeRequestLog: { body: { udId: true } },
    device,
    stringify: JSON.stringify
  })
}

async function trustDevice (smsCode, device) {
  return callGate(`https://${host}/SBOLServer/rest/registration/trustedDevice`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8'
    },
    body: {
      smsCode,
      udId: device.udid
    },
    sanitizeRequestLog: { body: { smsCode: true, udId: true } },
    device,
    stringify: JSON.stringify
  })
}

async function initiateLoginSequence (auth, device) {
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Authorization: getAuthToken(auth)
    },
    body: {
      client_id: auth.login,
      client_secret: auth.password,
      grant_type: 'client_credentials'
    },
    sanitizeRequestLog: { headers: { Authorization: true }, body: { client_id: true, client_secret: true } },
    device
  }
  const newDevice = generateDevice(device)
  let response = await callGate(`https://${host}/SBOLServer/oauth/token`, options)
  if ([400, 401].includes(response.status)) {
    if (response.body.error_description) {
      if ([
        'Invalid username or password',
        'Неверное имя пользователя или пароль'
      ].some(str => response.body.error_description.indexOf(str) >= 0)) {
        throw new InvalidLoginOrPasswordError()
      }
      if ([
        'Неверный имя пользователя или пароль',
        'Аккаунт временно заблокирован',
        'Попробуйте после'
      ].some(str => response.body.error_description.indexOf(str) >= 0)) {
        throw new InvalidPreferencesError(response.body.error_description)
      }
      if ([
        'Ожидается обработка Вашей заявки'
      ].some(str => response.body.error_description.indexOf(str) >= 0)) {
        throw new BankMessageError(response.body.error_description)
      }
      if ([
        /^.*blocked.*$/,
        /^.*Ваша учетная запись временно заблокирована.*$/,
        /^.*Необходимо подтвердить регистрацию.*$/
      ].some(regexp => response.body.error_description.match(regexp))) {
        throw new BankMessageError(response.body.error_description)
      }
      if (![
        'device',
        'неизвестного устройства'
      ].some(str => response.body.error_description.indexOf(str) >= 0)) {
        console.assert(false, 'Unknown login error')
      }
    }
    const optionsBearer = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Authorization: 'Bearer null'
      },
      body: {
        client_id: auth.login,
        client_secret: auth.password,
        grant_type: 'client_credentials'
      },
      sanitizeRequestLog: { headers: { Authorization: true }, body: { client_id: true, client_secret: true } },
      device
    }
    response = await callGate(`https://${host}/SBOLServer/oauth/token`, optionsBearer)
    if (response.headers['sbol-udid'] && response.headers['sbol-status'] && response.headers['sbol-status'] === 'new_device') {
      newDevice.udid = response.headers['sbol-udid']
    }
    response = await prepareDevice(newDevice)
    console.assert(response.body.errorInfo.errorCode === '0', 'Error while registering device.', response)

    const code = await ZenMoney.readLine('Введите код из SMS')
    response = await trustDevice(code, newDevice)
    if (response.body.errorInfo.errorCode === '1') {
      throw new InvalidOtpCodeError()
    } else {
      console.assert(response.body.errorInfo.errorCode === '0', 'Error while registering device.', response)
    }

    response = await callGate(`https://${host}/SBOLServer/oauth/token`, options)
  }
  return {
    response,
    device: newDevice
  }
}

export async function updateToken (auth) {
  const response = await callGate(`https://${host}/SBOLServer/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Authorization: getAuthToken(auth)
    },
    body: {
      client_id: auth.login,
      client_secret: auth.password,
      grant_type: 'client_credentials'
    },
    sanitizeRequestLog: { headers: { Authorization: true }, body: { client_id: true, client_secret: true } },
    device: auth.device
  })
  console.assert(response.body.access_token, 'Error, while getting token.', response)
  return {
    ...auth,
    token: response.body.access_token
  }
}

async function fetchListMoneyBox (auth) {
  const response = await callGate(`https://${host}/SBOLServer/rest/client/getListMoneybox`, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + auth.token
    },
    sanitizeRequestLog: { headers: { Authorization: true } },
    device: auth.device
  })
  if (response.body.error === 'invalid_token') {
    throw new AuthError()
  }
  console.assert(response.body.moneyboxs, 'Error fetching MoneyBoxs List.', response)
  return response.body.moneyboxs
}

export async function login ({ login, password }, device) {
  if (ZenMoney.trustCertificates) {
    ZenMoney.trustCertificates([
      `-----BEGIN CERTIFICATE-----
MIIFjDCCA3SgAwIBAgIQfx8skC6D0OO2+zvuR4tegDANBgkqhkiG9w0BAQsFADBM
MSAwHgYDVQQLExdHbG9iYWxTaWduIFJvb3QgQ0EgLSBSNjETMBEGA1UEChMKR2xv
YmFsU2lnbjETMBEGA1UEAxMKR2xvYmFsU2lnbjAeFw0yMzA3MTkwMzQzMjVaFw0y
NjA3MTkwMDAwMDBaMFUxCzAJBgNVBAYTAkJFMRkwFwYDVQQKExBHbG9iYWxTaWdu
IG52LXNhMSswKQYDVQQDEyJHbG9iYWxTaWduIEdDQyBSNiBBbHBoYVNTTCBDQSAy
MDIzMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA00Jvk5ADppO0rgDn
j1M14XIb032Aas409JJFAb8cUjipFOth7ySLdaWLe3s63oSs5x3eWwzTpX4BFkzZ
bxT1eoJSHfT2M0wZ5QOPcCIjsr+YB8TAvV2yJSyq+emRrN/FtgCSTaWXSJ5jipW8
SJ/VAuXPMzuAP2yYpuPcjjQ5GyrssDXgu+FhtYxqyFP7BSvx9jQhh5QV5zhLycua
n8n+J0Uw09WRQK6JGQ5HzDZQinkNel+fZZNRG1gE9Qeh+tHBplrkalB1g85qJkPO
J7SoEvKsmDkajggk/sSq7NPyzFaa/VBGZiRRG+FkxCBniGD5618PQ4trcwHyMojS
FObOHQIDAQABo4IBXzCCAVswDgYDVR0PAQH/BAQDAgGGMB0GA1UdJQQWMBQGCCsG
AQUFBwMBBggrBgEFBQcDAjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBS9
BbfzipM8c8t5+g+FEqF3lhiRdDAfBgNVHSMEGDAWgBSubAWjkxPioufi1xzWx/B/
yGdToDB7BggrBgEFBQcBAQRvMG0wLgYIKwYBBQUHMAGGImh0dHA6Ly9vY3NwMi5n
bG9iYWxzaWduLmNvbS9yb290cjYwOwYIKwYBBQUHMAKGL2h0dHA6Ly9zZWN1cmUu
Z2xvYmFsc2lnbi5jb20vY2FjZXJ0L3Jvb3QtcjYuY3J0MDYGA1UdHwQvMC0wK6Ap
oCeGJWh0dHA6Ly9jcmwuZ2xvYmFsc2lnbi5jb20vcm9vdC1yNi5jcmwwIQYDVR0g
BBowGDAIBgZngQwBAgEwDAYKKwYBBAGgMgoBAzANBgkqhkiG9w0BAQsFAAOCAgEA
fMkkMo5g4mn1ft4d4xR2kHzYpDukhC1XYPwfSZN3A9nEBadjdKZMH7iuS1vF8uSc
g26/30DRPen2fFRsr662ECyUCR4OfeiiGNdoQvcesM9Xpew3HLQP4qHg+s774hNL
vGRD4aKSKwFqLMrcqCw6tEAfX99tFWsD4jzbC6k8tjSLzEl0fTUlfkJaWpvLVkpg
9et8tD8d51bymCg5J6J6wcXpmsSGnksBobac1+nXmgB7jQC9edU8Z41FFo87BV3k
CtrWWsdkQavObMsXUPl/AO8y/jOuAWz0wyvPnKom+o6W4vKDY6/6XPypNdebOJ6m
jyaILp0quoQvhjx87BzENh5s57AIOyIGpS0sDEChVDPzLEfRsH2FJ8/W5woF0nvs
BTqfYSCqblQbHeDDtCj7Mlf8JfqaMuqcbE4rMSyfeHyCdZQwnc/r9ujnth691AJh
xyYeCM04metJIe7cB6d4dFm+Pd5ervY4x32r0uQ1Q0spy1VjNqUJjussYuXNyMmF
HSuLQQ6PrePmH5lcSMQpYKzPoD/RiNVD/PK0O3vuO5vh3o7oKb1FfzoanDsFFTrw
0aLOdRW/tmLPWVNVlAb8ad+B80YJsL4HXYnQG8wYAFb8LhwSDyT9v+C1C1lcIHE7
nE0AAp9JSHxDYsma9pi4g0Phg3BgOm2euTRzw7R0SzU=
-----END CERTIFICATE---—`
    ])
  }
  if (password === login) {
    throw new InvalidPreferencesError('Логин и пароль не могут быть одинаковыми')
  }
  if (password.length < 8) {
    throw new InvalidPreferencesError('Пароль должен быть не менее 8 символов')
  }
  const loginResult = await initiateLoginSequence({
    login,
    password
  }, device)
  const accessToken = loginResult.response.body.access_token
  return {
    login,
    password,
    token: accessToken,
    device: loginResult.device
  }
}

export async function fetchAccounts (auth) {
  const response = await callGate(`https://${host}/SBOLServer/rest/client/contracts`, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + auth.token
    },
    sanitizeRequestLog: { headers: { Authorization: true } },
    device: auth.device
  })
  if (response.body.error === 'invalid_token') {
    throw new AuthError()
  }
  if (response.body.contracts) {
    const moneyBoxes = await fetchListMoneyBox(auth)
    const accounts = response.body.contracts
    await updateBalances(auth, accounts)
    return {
      accounts,
      moneyBoxes
    }
  }
  console.assert(false, 'Error fetching accounts.', response)
}

export async function updateBalances (auth, accounts) {
  await Promise.all(accounts.map(async (account) => {
    if (account.cardList && account.cardList.length > 0) {
      const card = account.cardList[0]
      const response = await callGate(`https://${host}/SBOLServer/rest/client/balance`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + auth.token,
          'Content-Type': 'application/json;charset=UTF-8'
        },
        body: {
          cardExpire: card.yearEnd + '-' + card.monthEnd + '-15',
          cardId: card.cardId,
          currency: +account.currencyCode
        },
        sanitizeRequestLog: { headers: { Authorization: true } }, // , body: { cardExpire: true, cardId: true, currency: true } },
        device: auth.device,
        stringify: JSON.stringify
      })
      console.assert(response.body.errorInfo && response.body.errorInfo.errorCode === '0', 'Error while getting actual balance for account', account)
      updateAccountBalance(account, response)
    }
  })
  )
}

export function updateAccountBalance (account, response) {
  account.amount = response.body.amount
  account.overdraftLimit = response.body.overdraft
}

export async function fetchTransactions (auth, products, fromDate, toDate, contractNumber = []) {
  const transactions = []
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      Authorization: 'Bearer ' + auth.token
    },
    sanitizeRequestLog: { headers: { Authorization: true } },
    device: auth.device,
    stringify: JSON.stringify
  }
  let response
  await Promise.all(products.map(async (product) => {
    response = await callGate(`https://${host}/SBOLServer/rest/client/holdEvents`, {
      ...options,
      body: {
        cardId: product.id
      }
    })
    if (response.body.error === 'invalid_token') {
      throw new AuthError()
    }
    if (response.body.event) {
      transactions.push(...response.body.event)
    }
  }))

  response = await callGate(`https://${host}/SBOLServer/rest/client/events`, {
    ...options,
    body: {
      contractNumber,
      endDate: toISODateString(toDate),
      startDate: toISODateString(fromDate)
    }
  })
  if (response.body.error === 'invalid_token') {
    throw new AuthError()
  }
  if (response.body.event) {
    transactions.push(...response.body.event)
    return transactions
  }
  console.assert(false, 'Error fetching transactions,', response)
}
