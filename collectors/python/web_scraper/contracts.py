"""Validated collector inputs and normalized public output contracts."""

import re
from dataclasses import dataclass
from datetime import date
from typing import Literal, TypedDict
from urllib.parse import urlencode, urlsplit

Target = Literal["amazon", "indeed", "booking"]
Mode = Literal["standard", "managed"]


class CollectorError(Exception):
    """Safe public failure; never include raw transport exceptions or authenticated URLs."""

    def __init__(self, code: str, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status


class Book(TypedDict):
    searchTerm: str
    asin: str
    title: str
    authors: list[str]
    url: str
    price: str | None
    rating: str | None
    reviews: str | None
    image: str | None


class Job(TypedDict):
    jobId: str
    title: str
    company: str
    location: str
    url: str


class Hotel(TypedDict):
    name: str
    url: str
    price: str | None
    currency: str | None
    rating: str | None
    reviewCount: int | None
    location: str | None


type Records = list[Book] | list[Job] | list[Hotel]


def search_text(value: str, field: str = "query") -> str:
    value = value.strip()
    if not 1 <= len(value) <= 200 or any(ord(char) < 32 for char in value):
        raise CollectorError("invalid_input", f"{field} must contain 1–200 printable characters.")
    return value


@dataclass(frozen=True)
class BookingInput:
    destination: str
    checkin: str
    checkout: str
    adults: int
    rooms: int

    def validated(self) -> BookingInput:
        destination = search_text(self.destination, "destination")
        try:
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", self.checkin) or not re.fullmatch(
                r"\d{4}-\d{2}-\d{2}", self.checkout
            ):
                raise ValueError
            start, end = date.fromisoformat(self.checkin), date.fromisoformat(self.checkout)
        except ValueError:
            raise CollectorError(
                "invalid_input", "Booking dates must be valid ISO YYYY-MM-DD dates."
            ) from None
        if end <= start or self.adults < 1 or self.rooms < 1:
            raise CollectorError(
                "invalid_input", "Checkout must follow check-in; adults and rooms must be positive."
            )
        return BookingInput(destination, self.checkin, self.checkout, self.adults, self.rooms)

    def url(self) -> str:
        value = self.validated()
        return "https://www.booking.com/searchresults.html?" + urlencode(
            {
                "ss": value.destination,
                "checkin": value.checkin,
                "checkout": value.checkout,
                "group_adults": value.adults,
                "no_rooms": value.rooms,
                "group_children": 0,
            }
        )


def amazon_url(query: str) -> str:
    return "https://www.amazon.com/s?" + urlencode({"k": search_text(query), "i": "stripbooks"})


def indeed_url(query: str, location: str) -> str:
    return "https://www.indeed.com/jobs?" + urlencode(
        {"q": search_text(query), "l": search_text(location, "location")}
    )


def validate_target_url(url: str, target: Target) -> None:
    expected = {
        "amazon": ("www.amazon.com", "/s"),
        "indeed": ("www.indeed.com", "/jobs"),
        "booking": ("www.booking.com", "/searchresults.html"),
    }[target]
    try:
        parts = urlsplit(url)
        valid = (
            parts.scheme == "https" and parts.hostname == expected[0] and parts.path == expected[1]
        )
        valid = (
            valid
            and parts.username is None
            and parts.password is None
            and parts.port in (None, 443)
        )
    except ValueError:
        valid = False
    if not valid:
        raise CollectorError("unexpected_url", "The response left the expected target results URL.")
