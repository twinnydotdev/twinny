import React from 'react'

export const ChatbotAvatar = () => {
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="50" cy="50" r="45" fill="#AEC6CF" />
      <circle cx="35" cy="40" r="8" fill="#fff" />
      <circle cx="65" cy="40" r="8" fill="#fff" />
      <path
        d="M 35,60 Q 50,75 65,60"
        stroke="#fff"
        stroke-width="5"
        fill="none"
      />
    </svg>
  )
}

export const UserAvatar = () => {
  return (
    <svg
      width="30"
      height="30"
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="50" cy="50" r="45" fill="#FFB347" />
      <circle cx="35" cy="40" r="8" fill="#fff" />
      <circle cx="65" cy="40" r="8" fill="#fff" />
      <path
        d="M 35,60 Q 50,75 65,60"
        stroke="#fff"
        stroke-width="5"
        fill="none"
      />
    </svg>
  )
}
