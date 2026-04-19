import {
  fetchAccounts,
  fetchFullTransactions,
  login,
  parseTransactions,
  fetchDeposits,
  parseDeposits
} from './api'
import { convertAccount, convertTransaction } from './converters'

export async function scrape ({ preferences, fromDate, toDate }) {
  toDate = toDate || new Date()
  const token = await login(preferences.login, preferences.password)

  let accounts = await (await fetchAccounts(token))
    .map(convertAccount)
    .filter(account => account !== null)

  if (accounts.length === 0) {
    // если активация первый раз, но карточки все еще не выпущены
    return {
      accounts: [],
      transactions: []
    }
  }

  const transactionsStatement = []
  accounts = await Promise.all(accounts.map(async account => {
    if (account._meta.statementExecutionId) {
      console.log('Receive for', account.title)
      const htmls = await fetchFullTransactions(token, account, fromDate, toDate)
      const transactions = parseTransactions(htmls)
      console.log('Parsed for', account.title, transactions)
      for (const apiTransaction of transactions) {
        const transaction = convertTransaction(apiTransaction, account)
        if (transaction) {
          transactionsStatement.push(transaction)
        }
      }
    }
    if (account._meta.lastTrxExecutionId) {
      const mails = await fetchDeposits(token, account)
      if (mails) {
        const transactions = parseDeposits(mails, fromDate)
        for (const apiTransaction of transactions) {
          const transaction = convertTransaction(apiTransaction, account)
          if (transaction) {
            transactionsStatement.push(transaction)
          }
        }
      }
    }
    return account
  }))

  return {
    accounts,
    transactions: transactionsStatement
  }
}
