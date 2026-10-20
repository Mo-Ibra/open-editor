export const TITLE_TEXT_SELECTOR = '[data-title-text]'

export function focusTitleText(): void {
  if (typeof document === 'undefined') return
  setTimeout(() => {
    document
      .querySelector<HTMLButtonElement>('[data-title-inspector-collapsed] [data-panel-toggle="title-collapsed"]')
      ?.click()
    setTimeout(() => {
      const field = document.querySelector<HTMLTextAreaElement>(TITLE_TEXT_SELECTOR)
      if (!field) return
      field.focus()
      field.select()
    }, 0)
  }, 0)
}
