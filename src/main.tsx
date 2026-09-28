import { render } from 'solid-js/web'
import { App } from './app.js'
import { install } from './debug.js'

const root = document.getElementById('root')
if (!root) throw new Error('index.html is missing #root')

// Mirror everything to the dev-server terminal before anything else runs, so
// even a failure during startup is visible where we are already looking.
install()

render(() => <App />, root)
